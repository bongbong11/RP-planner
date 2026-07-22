// RP Planner v5 — SillyTavern Extension

import { event_types } from '../../../events.js';
import { MacrosParser } from '../../../macros.js';
import { registerSlashCommand } from '../../../slash-commands.js';

const EXT        = 'rp-planner';
const INJECT_KEY = 'rp-planner-inject';
const LOG        = '[RPPlanner]';
const QUICK_REPLY_SCRIPT=`/buttons labels=["1개월","3개월","6개월","12개월"] <b>📅 일정 생성</b><br>얼마 동안의 일정을 만들까요? |
/let span {{pipe}} |
/if left={{var::span}} right="" rule=eq {: /abort :} |
/cal-future | /let busy {{pipe}} |
/if left={{var::busy}} right="" rule=eq {: /popup 현재 RP 날짜를 먼저 설정해주세요! | /abort :} |
/echo severity=info timeout=60000 📅 {{var::span}}치 일정 짜는 중… |
/let op {:/preset:}() |
/preset 속마음용 |
/gen lock=on [OOC: Out-of-character task. Do NOT roleplay or write any prose. Context JSON — 'today' is the CURRENT in-story date, 'booked' lists dates that already have events: {{var::busy}} Starting from the day AFTER 'today', create {{var::span}} worth of upcoming schedule entries for {{char}}, fitting the story's setting and {{char}}'s life. Rules: every entry MUST fall within {{var::span}} counted forward from 'today' — never before 'today', never beyond that window; never place an entry on a date listed in 'booked'; spread entries out naturally; do not put two entries on the same date. CRITICAL — only things that can genuinely be PLANNED IN ADVANCE: appointments, deadlines, exams, trips, meetings, performances, anniversaries, reservations, scheduled work shifts, classes, checkups. NEVER invent unforeseeable events (illness, accidents, someone catching a cold, sudden fights, weather, chance encounters) or anything that depends on how the story unfolds. A calendar holds commitments, not plot predictions. Output ONE entry per line in EXACTLY this format, nothing else: M/D : 제목 No numbering, no bullets, no markdown fence, no commentary. Titles in KOREAN.] |
/let plan {{pipe}} |
/preset {{var::op}} |
/re-replace find=/\`\`\`[a-z]*/g replace="" {{var::plan}} | /var plan {{pipe}} |
/split find=/[\\r\\n]+/ trim=on {{var::plan}} | /let lines {{pipe}} |
/buttons multiple=on labels={{var::lines}} <span class="rpp-quick-schedule-picker"><b>📅 이 일정으로 등록할까요?</b><br>빼고 싶은 건 체크 해제하세요</span> |
/let picked {{pipe}} |
/let n {:/len {{var::picked}}:}() |
/if left={{var::n}} right=0 rule=eq {: /popup 등록 취소했어요! | /abort :} |
/let added 0 |
/let c 0 |
/foreach {{var::picked}} {:
    /cal-import {{var::item}} | /var c {{pipe}} |
    /var added {:/add {{var::added}} {{var::c}}:}() |
:} |
/popup wide=on large=on scroll=on <b>📅 일정 등록 완료</b><br><br><b>{{var::added}}</b>개 등록됨 ({{var::span}})`;

let ctx = null;
let initPromise = null;
function getCtx() { if(!ctx) ctx=SillyTavern.getContext(); return ctx; }

// ─── 채팅별 데이터 키 ────────────────────────────────────────
function getCurrentCharName() {
    const c=getCtx();
    const aiMsg=[...(c.chat||[])].reverse().find(m=>!m.is_user&&!m.is_system);
    return aiMsg?.name||'global';
}

function shortHash(value) {
    let hash=2166136261;
    for(const ch of String(value)){
        hash^=ch.charCodeAt(0);
        hash=Math.imul(hash,16777619);
    }
    return (hash>>>0).toString(36);
}

function getCurrentChatIdentity() {
    const c=getCtx();
    const chatId=c.chatId??c.chat_id??c.chatMetadata?.chat_id??c.chat_metadata?.chat_id;
    const owner=getCurrentChatOwner();
    // chatId is the SillyTavern chat filename/id. Including the owner prevents a
    // coincidentally identical filename in another character/group from colliding.
    if(chatId!=null&&String(chatId).trim())return `${owner}|chat:${String(chatId).trim()}`;
    // Unsaved chats normally acquire chatId as soon as the first message is saved.
    // Keep their temporary record owner-scoped instead of falling back to a global key.
    return `${owner}|unsaved`;
}

function getCurrentChatOwner() {
    const c=getCtx();
    return c.groupId!=null?`group:${c.groupId}`:`character:${c.characterId??getCurrentCharName()}`;
}

function chatKeyFromIdentity(identity) { return `chat_${shortHash(identity)}`; }

function charKey() {
    return chatKeyFromIdentity(getCurrentChatIdentity());
}

function legacyCharKey() {
    const name=getCurrentCharName();
    return `char_${name.replace(/\s+/g,'_')}`;
}

const CHAR_DEFAULTS = {
    schedules:   [],
    backupSlots: [],
    currentDT:   null,
    processedMessageHashes: [],
};

const GLOBAL_DEFAULTS = {
    syncMode:      'auto',
    syncPattern:   'Date: YYYY.MM.DD',
    maxUpcoming:   20,
    maxPast:       10,
    darkMode:      false,
    charData:      {},
};

function S() {
    const c=getCtx();
    if(!c.extensionSettings[EXT]) c.extensionSettings[EXT]=structuredClone(GLOBAL_DEFAULTS);
    const d=c.extensionSettings[EXT];
    if(!d.charData)      d.charData={};
    if(!d.syncPattern)   d.syncPattern='Date: YYYY.MM.DD';
    if(d.syncMode===undefined) d.syncMode='auto';
    if(d.maxUpcoming===undefined) d.maxUpcoming=20;
    if(d.maxPast===undefined)     d.maxPast=10;
    if(d.darkMode===undefined)    d.darkMode=false;
    return d;
}

function CD() {
    const s=S(), k=charKey();
    const pendingKey=chatKeyFromIdentity(`${getCurrentChatOwner()}|unsaved`);
    if(k!==pendingKey&&!s.charData[k]&&s.charData[pendingKey]){
        s.charData[k]=s.charData[pendingKey];
        delete s.charData[pendingKey];
        save();
    }
    // One-time migration: move the old character-wide record into the first chat
    // that opens it. Moving (not copying) prevents it leaking into other chats.
    const legacy=legacyCharKey();
    if(!s.charData[k]&&s.charData[legacy]){
        s.charData[k]=s.charData[legacy];
        delete s.charData[legacy];
        save();
    }
    if(!s.charData[k]) s.charData[k]=structuredClone(CHAR_DEFAULTS);
    const d=s.charData[k];
    if(!d.backupSlots) d.backupSlots=[];
    if(!Array.isArray(d.processedMessageHashes))d.processedMessageHashes=[];
    return d;
}

function save() { getCtx().saveSettingsDebounced(); }

// ─── 고아 데이터 정리 ────────────────────────────────────────
function pruneOrphanedData() {
    const c=getCtx();
    const s=S();
    const charData=s.charData||{};
    let changed=false;

    // 1) Legacy character-wide keys are removed after migration. Chat records
    // cannot be safely matched against the current character list, so age/count
    // caps below are used instead of accidentally deleting another chat's data.
    const currentKey=charKey();
    for(const key of Object.keys(charData)){
        if(key!==legacyCharKey()&&key.startsWith('char_')){
            delete charData[key];
            changed=true;
        }
    }

    // 2) 안전망: 채팅 데이터 총 개수 캡 (너무 많아지면 오래된 것부터 삭제)
    const MAX_CHATS=100;
    const keys=Object.keys(charData);
    if(keys.length>MAX_CHATS){
        // backupSlots의 savedAt 또는 schedules의 createdAt 중 가장 최근 것 기준 정렬
        const scored=keys.map(k=>{
            const d=charData[k];
            const times=[
                ...(d.schedules||[]).map(x=>x.createdAt||0),
                ...(d.backupSlots||[]).map(x=>x.savedAt||0),
            ];
            return{key:k,last:times.length?Math.max(...times):0};
        }).sort((a,b)=>a.last-b.last);
        const toRemove=scored.slice(0,keys.length-MAX_CHATS).map(x=>x.key).filter(k=>k!==currentKey);
        toRemove.forEach(k=>{delete charData[k];changed=true;});
    }

    // 3) 각 채팅의 schedules 배열 캡 (무한 누적 방지)
    const MAX_SCHEDULES=300;
    for(const key of Object.keys(charData)){
        const d=charData[key];
        if(d.schedules&&d.schedules.length>MAX_SCHEDULES){
            d.schedules.sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
            d.schedules=d.schedules.slice(d.schedules.length-MAX_SCHEDULES);
            changed=true;
        }
    }

    if(changed){ s.charData=charData; save(); console.log(LOG,'고아 데이터 정리 완료'); }
}

// ─── 유틸 ────────────────────────────────────────────────────
function uid()  { return Date.now().toString(36)+Math.random().toString(36).slice(2,5); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return esc(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

function cmpDate(a,b) {
    const currentYear=CD().currentDT?.year??new Date().getFullYear();
    const ay=a.year??currentYear;
    const by=b.year??currentYear;
    if(ay!==by)return ay-by;
    if(a.month!==b.month)return a.month-b.month;
    return a.day-b.day;
}
function isPast(s,cur)  { return cur?cmpDate(s,cur)<0:false; }
function isToday(s,cur) { return cur?cmpDate(s,cur)===0:false; }

function fmtDate(d) {
    if(!d)return '—';
    const y=d.year?`${d.year}.`:'';
    return `${y}${String(d.month).padStart(2,'0')}.${String(d.day).padStart(2,'0')}`;
}
function fmtTime(d) {
    if(!d||d.hour==null)return '';
    const ampm=d.hour<12?'AM':'PM';
    const h=d.hour%12||12;
    return `${String(h).padStart(2,'0')}:${String(d.minute??0).padStart(2,'0')} ${ampm}`;
}
function fmtDayName(d) {
    if(!d)return '';
    const days=['SUN','MON','TUE','WED','THU','FRI','SAT'];
    const date=new Date(d.year??2000,d.month-1,d.day);
    return days[date.getDay()];
}

// ─── 인포블럭 파싱 ───────────────────────────────────────────
function parseInfoBlock(text) {
    const dateRe=/(?:Date|날짜)\s*:\s*(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/i;
    const timeRe=/(?:Time|시간)\s*:\s*(\d{1,2}):(\d{2})/i;
    const dm=dateRe.exec(text);
    if(!dm)return null;
    const r={year:+dm[1],month:+dm[2],day:+dm[3],hour:null,minute:null,season:null};
    const tm=timeRe.exec(text); if(tm){r.hour=+tm[1];r.minute=+tm[2];}
    return r;
}

// ─── OOC 블록 정규식 파싱 ────────────────────────────────────
// May 1 — 내용 / May 1-3 — 내용 / May 1~3 — 내용 / **May 1** — 내용 / - May 1 — 내용
function parseOOCSchedules(chat) {
    const s=S();
    const yr=CD().currentDT?.year??null;
    const months={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,
                  september:9,october:10,november:11,december:12,
                  jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
    const found=[], seen=new Set();

    // 전체 채팅에서 OOC 블록 추출
    const aiMsgs=chat.filter(m=>!m.is_user&&!m.is_system);
    const oocBlocks=[];
    for(const msg of aiMsgs){
        const text=msg.mes||'';
        // (OOC: ...) 블록
        const matches=[...text.matchAll(/\(OOC:[\s\S]*?\)/gi)];
        matches.forEach(m=>oocBlocks.push(m[0]));
        // OOC: 로 시작하는 줄부터 다음 비OOC까지 (괄호 없는 형식)
        if(/^OOC:/im.test(text)) oocBlocks.push(text);
    }

    // OOC 블록에서 날짜+내용 파싱
    // 패턴: (선택)- (선택)** Month D[-~D] ** (선택) — 내용
    const lineRe=/(?:^|\n)\s*[-*]?\s*\*{0,2}(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?\s+(\d{1,2})(?:\s*[-~]\s*(\d{1,2}))?\*{0,2}\.?\s*[-—:]\s*(.+)/gi;

    for(const block of oocBlocks){
        let m;
        lineRe.lastIndex=0;
        while((m=lineRe.exec(block))!==null){
            const mo=months[m[1].toLowerCase()];
            const d1=+m[2];
            const d2=m[3]?+m[3]:d1;
            if(!mo||d1<1||d1>31)continue;
            // 내용 파싱: 대시 두 개 처리 (May 15 — DEPLOYED — Field training)
            const rawContent=m[4].trim();
            // 첫번째 — 까지가 title, 그 이후가 note
            const dashIdx=rawContent.search(/\s+[-—]\s+/);
            let title, note='';
            if(dashIdx>0){
                title=rawContent.slice(0,dashIdx).trim();
                note=rawContent.slice(dashIdx).replace(/^\s*[-—]\s*/,'').trim();
            } else {
                title=rawContent;
            }
            // 마크다운 클린업
            title=title.replace(/^\*+|\*+$/g,'').replace(/✅|⚠️/g,'').trim();
            note=note.replace(/^\*+|\*+$/g,'').trim();
            if(!title||title.length<1)continue;

            const k=`${mo}-${d1}-${title}`;
            if(!seen.has(k)){
                seen.add(k);
                found.push({year:yr,month:mo,day:d1,dayEnd:d2,title,note:note||''});
            }
        }
    }
    return found;
}

// 파싱 결과를 스케쥴에 등록 (날짜 범위 펼치기 포함)
function applyParsedSchedules(parsed) {
    const d=CD(), s=S();
    const yr=CD().currentDT?.year??null;
    let added=0;
    for(const f of parsed) {
        if(!f.month||!f.day) continue;
        const startDay=+f.day;
        const endDay=f.dayEnd?+f.dayEnd:startDay;
        const year=f.year??yr;
        for(let day=startDay;day<=endDay;day++){
            if(!d.schedules.some(x=>(x.year??yr)===year&&x.month===+f.month&&x.day===day&&x.title===f.title)){
                d.schedules.push({
                    id:uid(),
                    month:+f.month,
                    day,
                    year,
                    title:(f.title||'').trim(),
                    note:(f.note||'').trim(),
                    done:false,
                    source:'auto',
                    createdAt:Date.now(),
                });
                added++;
            }
        }
    }
    if(added){sortAndAutoCheck();save();injectContext();}
    return added;
}

// txt/json 파일 불러오기
async function importScheduleFile(file) {
    return new Promise((resolve,reject)=>{
        const reader=new FileReader();
        reader.onload=e=>{
            try{
                const text=e.target.result.trim();
                let added=0;
                if(text.startsWith('[')||text.startsWith('{')){
                    const parsed=JSON.parse(text);
                    const arr=Array.isArray(parsed)?parsed:[parsed];
                    added=applyParsedSchedules(arr);
                } else {
                    const lines=text.split('\n');
                    const parsed=[];
                    for(const line of lines){
                        const l=line.trim();
                        if(!l||l.startsWith('#'))continue;
                        const m=l.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:-(\d{1,2}))?\s*[:：]\s*(.+)/);
                        if(!m)continue;
                        const [,ye,mo,d1,d2,rest]=m;
                        const parts=rest.split('/');
                        const title=parts[0].trim();
                        const note=parts[1]?.trim()||'';
                        parsed.push({year:+ye,month:+mo,day:+d1,dayEnd:d2?+d2:undefined,title,note});
                    }
                    added=applyParsedSchedules(parsed);
                }
                resolve(added);
            } catch(err){reject(err);}
        };
        reader.onerror=reject;
        reader.readAsText(file);
    });
}

function parseAllMessages() {
    const c=getCtx();
    const chat=c.chat;
    if(!chat?.length)return{dateUpdated:false,added:0};
    const aiMsgs=[...chat].filter(m=>!m.is_user&&!m.is_system);
    if(!aiMsgs.length)return{dateUpdated:false,added:0};
    const s=S();
    let dateUpdated=false;
    const lastAI=aiMsgs[aiMsgs.length-1];
    const dt=parseInfoBlock(lastAI.mes||'');
    if(dt){CD().currentDT=dt;dateUpdated=true;calYear=dt.year??calYear;calMonth=dt.month??calMonth;sortAndAutoCheck();save();injectContext();}
    return{dateUpdated,added:0};
}

function parseLastOnly() {
    const c=getCtx();
    const chat=c.chat;
    if(!chat?.length)return{dateUpdated:false,added:0};
    const lastAI=[...chat].filter(m=>!m.is_user&&!m.is_system).slice(-1)[0];
    if(!lastAI)return{dateUpdated:false,added:0};
    const s=S();
    const dt=parseInfoBlock(lastAI.mes||'');
    let dateUpdated=false;
    if(dt){CD().currentDT=dt;dateUpdated=true;calYear=dt.year??calYear;calMonth=dt.month??calMonth;sortAndAutoCheck();save();injectContext();}
    return{dateUpdated,added:0};
}

// ─── AI 스케쥴 파싱 (연결 프로필 사용) ──────────────────────
function messageHash(msg) {
    const stableTime=msg.send_date??msg.extra?.api_timestamp??'';
    const input=`${msg.is_user?'user':'assistant'}\n${stableTime}\n${msg.mes||''}`;
    let hash=2166136261;
    for(let i=0;i<input.length;i++){
        hash^=input.charCodeAt(i);
        hash=Math.imul(hash,16777619);
    }
    return (hash>>>0).toString(36);
}

function getUnprocessedMessages(chat) {
    const done=new Set(CD().processedMessageHashes||[]);
    const result=[];
    let activeDate=null;
    for(const message of chat){
        if(message.is_system)continue;
        const parsedDate=parseInfoBlock(message.mes||'');
        if(parsedDate)activeDate=parsedDate;
        if(!(message.mes||'').trim())continue;
        const hash=messageHash(message);
        if(!done.has(hash))result.push({message,hash,contextDate:activeDate?{...activeDate}:null});
    }
    return result;
}

function markMessagesProcessed(items) {
    const d=CD();
    d.processedMessageHashes=[...new Set([...(d.processedMessageHashes||[]),...items.map(x=>x.hash)])].slice(-1200);
    save();
}

function extractScheduleRelevantText(items) {
    return items.map(({message,contextDate})=>{
        const role=message.is_user?'USER':'ASSISTANT';
        const date=contextDate?`${contextDate.year}-${contextDate.month}-${contextDate.day}`:'unknown';
        return `[${role} | IN-STORY DATE AT THIS MESSAGE: ${date}]\n${message.mes||''}`;
    }).join('\n\n--- MESSAGE ---\n\n');
}

async function aiParseScheduleBatch(items) {
    const s=S(), c=getCtx();
    const profileId=s.syncProfileId;
    if(!profileId) return{error:'연결 프로필을 먼저 설정해주세요 (설정 탭)'};
    if(!items.length) return{parsed:[]};

    const filteredText=extractScheduleRelevantText(items);
    if(!filteredText.trim()) return{parsed:[]};

    const curDT=CD().currentDT;
    const curDateStr=curDT?`${curDT.year??''}년 ${curDT.month}월 ${curDT.day}일`:null;

    const existing=CD().schedules.map(x=>({year:x.year,month:x.month,day:x.day,title:x.title}));
    const systemPrompt=`You are a calendar extraction tool. Current in-story date: ${curDateStr||'unknown'}.

Each message is labelled with the in-story date active at that point in the chat. Use that per-message date—not the final current date—when resolving relative expressions such as tomorrow or next Friday. If a message date is unknown, do not guess a relative date.

Read both USER and ASSISTANT messages and extract ONLY commitments that belong on a calendar.

Include only events with a definite or reliably calculable date: appointments, reservations, meetings, deadlines, exams, trips, performances, scheduled work, classes, checkups, anniversaries, and explicitly planned personal commitments.

Exclude wishes, possibilities, vague future intentions, routines without a specific date, completed events, narration, weather, illness, accidents, fights, chance encounters, predictions, and plot speculation. Do not invent missing dates or details. Resolve relative dates only when the current in-story date makes the result unambiguous.

Output ONLY a JSON array in this exact schema:
[{"year":2027,"month":5,"day":3,"dayEnd":null,"title":"짧은 한국어 일정명","note":"필요한 구체 정보만 또는 빈 문자열"}]

Formatting rules:
- One event per object. Never write prose or markdown.
- title must be a concise Korean calendar label, not a sentence.
- note must contain only useful fixed details such as time, place, person, or reservation information.
- Do not repeat title information in note.
- dayEnd is used only for an explicitly stated continuous date range; otherwise null.
- Existing calendar entries are reference only. Do not output an exact duplicate with the same date and title.
- Return [] when no valid schedule exists.

Existing entries:
${JSON.stringify(existing)}`;

    try {
        const userContent=`${systemPrompt}\n\n===CHAT===\n${filteredText}`;
        const messages=[{role:'user',content:userContent}];
        const response=await c.ConnectionManagerRequestService.sendRequest(
            profileId, messages, 1000,
            {stream:false, extractData:true, includePreset:false, includeInstruct:false}
        );

        let raw='';
        if(typeof response==='string') raw=response;
        else if(typeof response?.content==='string') raw=response.content;
        else if(response?.choices?.[0]?.message?.content) raw=response.choices[0].message.content;
        else if(response?.content?.[0]?.text) raw=response.content[0].text;
        else { console.error('[RPPlanner] Unknown response structure:', response); return{error:'알 수 없는 응답 형식'}; }

        const clean=raw.replace(/```json|```/g,'').trim();
        const jsonMatch=clean.match(/\[[\s\S]*\]/);
        if(!jsonMatch) return{error:'AI 응답 파싱 실패'};

        const parsed=JSON.parse(jsonMatch[0]);
        if(!Array.isArray(parsed)) return{error:'잘못된 응답 형식'};

        return{parsed};
    } catch(err) {
        console.error('[RPPlanner] AI parse error:', err);
        return{error:err.message||'AI 호출 실패'};
    }
}

async function aiParseSchedules(items) {
    const batches=[];
    let batch=[],size=0;
    for(const item of items){
        const itemSize=(item.message.mes||'').length+120;
        if(batch.length&&size+itemSize>24000){batches.push(batch);batch=[];size=0;}
        batch.push(item);size+=itemSize;
    }
    if(batch.length)batches.push(batch);

    const parsed=[];
    for(const part of batches){
        const result=await aiParseScheduleBatch(part);
        if(result.error)return result;
        parsed.push(...(result.parsed||[]));
    }
    return{parsed};
}

function normalizeParsedSchedules(items) {
    const cur=CD().currentDT;
    const existing=CD().schedules;
    const seen=new Set();
    const clean=[];
    for(const raw of items||[]){
        const month=+raw.month,day=+raw.day;
        let year=raw.year?+raw.year:(cur?.year??null);
        if(year&&cur?.year&&!raw.year&&(month<cur.month||(month===cur.month&&day<cur.day)))year++;
        const title=String(raw.title||'').replace(/[\r\n]+/g,' ').replace(/^[-*•\s]+|[.。\s]+$/g,'').trim();
        const note=String(raw.note||'').replace(/[\r\n]+/g,' ').trim();
        const dayEnd=raw.dayEnd?+raw.dayEnd:null;
        if(!title||month<1||month>12||day<1||day>31)continue;
        const testYear=year??2000;
        const valid=new Date(testYear,month-1,day);
        if(valid.getFullYear()!==testYear||valid.getMonth()!==month-1||valid.getDate()!==day)continue;
        const key=`${year??0}-${month}-${day}-${title.toLocaleLowerCase()}`;
        if(seen.has(key))continue;
        seen.add(key);
        if(existing.some(x=>(x.year??cur?.year??null)===year&&x.month===month&&x.day===day&&x.title.trim().toLocaleLowerCase()===title.toLocaleLowerCase()))continue;
        clean.push({year,month,day,dayEnd:dayEnd&&dayEnd>=day?dayEnd:null,title,note});
    }
    return clean;
}

function reviewParsedSchedules(items) {
    return new Promise(resolve=>{
        const overlay=document.createElement('div');
        overlay.className='rpp-review-overlay';
        const rows=items.map((x,i)=>`
          <div class="rpp-review-row" data-index="${i}">
            <label class="rpp-review-check"><input type="checkbox" class="rpp-review-use" checked> 등록</label>
            <div class="rpp-review-date">
              <input class="rpp-review-year" type="number" value="${x.year??''}" placeholder="연도">
              <span>/</span><input class="rpp-review-month" type="number" value="${x.month}" min="1" max="12">
              <span>/</span><input class="rpp-review-day" type="number" value="${x.day}" min="1" max="31">
            </div>
            <input class="rpp-review-title" type="text" value="${escAttr(x.title)}" placeholder="일정 제목">
            <input class="rpp-review-note" type="text" value="${escAttr(x.note)}" placeholder="시간·장소·상대 등 필요한 메모만">
          </div>`).join('');
        overlay.innerHTML=`<div class="rpp-review-dialog">
          <div class="rpp-review-head"><b>📅 파싱 결과 확인</b><span>${items.length}개</span></div>
          <div class="rpp-review-hint">등록하지 않을 일정은 체크를 해제하고, 제목과 메모는 바로 수정할 수 있어요.</div>
          <div class="rpp-review-list">${rows}</div>
          <div class="rpp-review-actions">
            <button class="rpp-btn rpp-review-cancel">취소</button>
            <button class="rpp-btn rpp-btn-primary rpp-review-save">선택 일정 등록</button>
          </div>
        </div>`;
        document.body.appendChild(overlay);

        const finish=value=>{overlay.remove();resolve(value);};
        overlay.querySelector('.rpp-review-cancel').addEventListener('click',()=>finish(null));
        overlay.querySelector('.rpp-review-save').addEventListener('click',()=>{
            const selected=[];
            overlay.querySelectorAll('.rpp-review-row').forEach((row,i)=>{
                if(!row.querySelector('.rpp-review-use').checked)return;
                const year=parseInt(row.querySelector('.rpp-review-year').value)||null;
                const month=parseInt(row.querySelector('.rpp-review-month').value);
                const day=parseInt(row.querySelector('.rpp-review-day').value);
                const title=row.querySelector('.rpp-review-title').value.trim();
                const note=row.querySelector('.rpp-review-note').value.trim();
                if(title&&month&&day)selected.push({...items[i],year,month,day,title,note});
            });
            finish(normalizeParsedSchedules(selected));
        });
    });
}

// ─── 스케쥴 CRUD ─────────────────────────────────────────────
function sortAndAutoCheck() {
    const d=CD(),cur=CD().currentDT;
    d.schedules.sort(cmpDate);
    if(cur)d.schedules.forEach(x=>{if(!x.done&&isPast(x,cur))x.done=true;});
}
function addSchedule({month,day,year=null,title,note='',source='manual'}) {
    CD().schedules.push({id:uid(),month:+month,day:+day,year:year?+year:null,title:title.trim(),note:note.trim(),done:false,source,createdAt:Date.now()});
    sortAndAutoCheck();save();injectContext();
}
function removeSchedule(id) { const d=CD();d.schedules=d.schedules.filter(x=>x.id!==id);save();injectContext(); }
function toggleDone(id)     { const d=CD();const x=d.schedules.find(x=>x.id===id);if(x){x.done=!x.done;save();injectContext();} }

// ─── Context 주입 ─────────────────────────────────────────────
function buildScheduleText() {
    const s=S(),d=CD(),cur=CD().currentDT,lines=[];
    const formatEntry=x=>{
        const date=[x.year,x.month,x.day].filter(v=>v!==null&&v!==undefined).join('/');
        const day=fmtDayName({year:x.year,month:x.month,day:x.day});
        const note=x.note?` | Note: ${x.note}`:'';
        return `- ${date}${day?` (${day})`:''} | ${x.title}${note}`;
    };

    lines.push('<RP_PLANNER_CONTEXT>');
    if(cur){
        const dt=fmtDate(cur),t=fmtTime(cur);
        const day=fmtDayName(cur);
        const season=cur.season?` | Season: ${cur.season}`:'';
        lines.push(`<CURRENT_IN_STORY_TIME>${dt} ${day}${t?` | ${t}`:''}${season}</CURRENT_IN_STORY_TIME>`);
    } else {
        lines.push('<CURRENT_IN_STORY_TIME>Unknown</CURRENT_IN_STORY_TIME>');
    }

    const active=d.schedules.filter(x=>!x.done&&(!cur||!isPast(x,cur))).slice(0,s.maxUpcoming??20);
    const today=cur?active.filter(x=>isToday(x,cur)):[];
    const upcoming=cur?active.filter(x=>!isToday(x,cur)):active;
    lines.push('<TODAY_COMMITMENTS>');
    if(today.length)today.forEach(x=>lines.push(formatEntry(x)));
    else lines.push('None');
    lines.push('</TODAY_COMMITMENTS>');

    lines.push('<UPCOMING_COMMITMENTS>');
    if(upcoming.length){
        const groups=[];
        for(const x of upcoming){
            const last=groups[groups.length-1];
            if(last&&last.title===x.title&&last.note===(x.note||'')&&last.year===x.year&&last.month===x.month&&x.day===last.endDay+1){
                last.endDay=x.day;
            } else {
                groups.push({month:x.month,day:x.day,endDay:x.day,title:x.title,note:x.note||'',year:x.year});
            }
        }
        groups.forEach(g=>{
            const startDay=fmtDayName({year:g.year,month:g.month,day:g.day});
            const endDay=fmtDayName({year:g.year,month:g.month,day:g.endDay});
            const year=g.year?`${g.year}/`:'';
            const dateStr=g.day===g.endDay
                ?`${year}${g.month}/${g.day} (${startDay})`
                :`${year}${g.month}/${g.day} (${startDay})–${g.month}/${g.endDay} (${endDay})`;
            const note=g.note?` | Note: ${g.note}`:'';
            lines.push(`- ${dateStr} | ${g.title}${note}`);
        });
    } else lines.push('None');
    lines.push('</UPCOMING_COMMITMENTS>');

    const past=d.schedules.filter(x=>x.done||(cur&&isPast(x,cur))).slice(-(s.maxPast??10));
    lines.push('<COMPLETED_EVENTS>');
    if(past.length){
        past.forEach(x=>lines.push(formatEntry(x)));
    } else lines.push('None');
    lines.push('</COMPLETED_EVENTS>');

    lines.push(`<RP_PLANNER_USAGE>
- Treat the current in-story time as the canonical temporal reference for this response.
- Treat listed commitments as the character's established schedule, known only to characters who would reasonably know it. Use it as material for temporal continuity and character behaviour, not as a checklist of events that must all be shown.
- When a commitment is relevant to the live scene or current time, let it naturally inform awareness, preparation, timing, priorities, reminders, dialogue, action, or consequences.
- Keep unrelated or distant commitments implicit. Do not force calendar exposition, mention every entry, steer the scene toward an entry, or make an event occur merely because it appears here.
- A future commitment is a current plan, not a guaranteed outcome. Do not jump time, begin it early, complete it, or decide its result unless the roleplay reaches that point.
- Completed events are past continuity. Do not schedule, initiate, or replay them as upcoming events.
- Do not invent, alter, cancel, or reschedule entries. Do not use an entry as permission to write unprovided {{user}} actions, dialogue, feelings, decisions, or consent.
</RP_PLANNER_USAGE>`);
    lines.push('</RP_PLANNER_CONTEXT>');
    return lines.join('\n');
}

function buildInjectText() {
    return buildScheduleText();
}

function injectContext() {
    // 프리셋 매크로 전용. 이전 버전에서 남은 직접 주입 프롬프트도 제거한다.
    getCtx().setExtensionPrompt?.(INJECT_KEY,'',1,0);
}

// ─── 백업 ────────────────────────────────────────────────────
function createBackupSlot(name) {
    const d=CD();
    const slot={id:uid(),name:name||`Backup ${new Date().toLocaleString()}`,
        data:JSON.parse(JSON.stringify({
            schedules:d.schedules,
            processedMessageHashes:d.processedMessageHashes,
            currentDT:CD().currentDT
        })),savedAt:Date.now()};
    d.backupSlots.unshift(slot);
    if(d.backupSlots.length>10)d.backupSlots=d.backupSlots.slice(0,10);
    save(); return slot;
}
function restoreBackupSlot(id) {
    const d=CD(),slot=d.backupSlots.find(x=>x.id===id);if(!slot)return false;
    if(slot.data.schedules)  d.schedules=JSON.parse(JSON.stringify(slot.data.schedules));
    if(slot.data.processedMessageHashes)d.processedMessageHashes=JSON.parse(JSON.stringify(slot.data.processedMessageHashes));
    if(slot.data.currentDT)  CD().currentDT=slot.data.currentDT;
    sortAndAutoCheck();save();injectContext();return true;
}
function deleteBackupSlot(id) { const d=CD();d.backupSlots=d.backupSlots.filter(x=>x.id!==id);save(); }
function exportToFile() {
    const data={
        format:'rp-planner-chat-backup',
        version:1,
        chatData:JSON.parse(JSON.stringify(CD())),
        exportedAt:Date.now()
    };
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=`rp-planner-${Date.now()}.json`;
    document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(url);
}
function importFromFile(file) {
    return new Promise((resolve,reject)=>{
        const reader=new FileReader();
        reader.onload=e=>{
            try{
                const data=JSON.parse(e.target.result),s=S(),key=charKey();
                if(data.format==='rp-planner-chat-backup'&&data.chatData){
                    s.charData[key]=Object.assign(structuredClone(CHAR_DEFAULTS),data.chatData);
                }else if(data.charData){
                    // Backward compatibility: import only one matching legacy/current
                    // record into this chat; never replace the whole data store.
                    const old=data.charData[key]??data.charData[legacyCharKey()];
                    if(!old)throw new Error('현재 채팅에 해당하는 백업 데이터가 없습니다');
                    s.charData[key]=Object.assign(structuredClone(CHAR_DEFAULTS),old);
                }else{
                    throw new Error('지원하지 않는 백업 파일입니다');
                }
                if(data.currentDT&&!s.charData[key].currentDT)s.charData[key].currentDT=data.currentDT;
                sortAndAutoCheck();save();injectContext();resolve(true);
            }catch(err){reject(err);}
        };
        reader.onerror=reject;reader.readAsText(file);
    });
}
function clearAllData() {
    const s=S(),key=charKey();
    // Delete the whole current-chat record. This also removes scan hashes and
    // internal backup slots, so deleted schedules cannot survive in a backup.
    delete s.charData[key];
    schedViewDate=null;
    save();
    injectContext();
}

// ══════════════════════════════════════════════════════════════
// UI STATE
// ══════════════════════════════════════════════════════════════
let panelOpen=false,activeTab='calendar';
let calYear=null,calMonth=null;
let schedViewDate=null;

function getPanelHTML() {
    return `<div id="rpp-panel">
  <div id="rpp-tabs">
    <button class="rpp-tab" data-tab="calendar" title="Calendar">📅</button>
    <button class="rpp-tab" data-tab="settings" title="Settings">⚙️</button>
    <div class="rpp-tab-spacer"></div>
    <button id="rpp-sync-btn" class="rpp-tab rpp-sync-icon" title="AI 스케쥴 파싱">⚡</button>
    <button id="rpp-close" class="rpp-tab rpp-close-tab">✕</button>
  </div>
  <div id="rpp-content"></div>
  <div id="rpp-toast"></div>
</div>`;
}

function switchTab(tab,opts={}) {
    activeTab=tab;
    document.querySelectorAll('.rpp-tab[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
    const c=document.getElementById('rpp-content');
    if(!c)return;
    if(opts.date)schedViewDate=opts.date;
    switch(tab){
        case 'calendar':  c.innerHTML=renderCalendar();  bindCalendarEvents(); bindScheduleEvents(); break;
        case 'settings':  c.innerHTML=renderSettings();  bindSettingsEvents();  break;
    }
    updateHeaderBtns();
}

function updateHeaderBtns() {
    // Header state hook retained for compatibility.
}

// ══════════════════════════════════════════════════════════════
// TAB 1: CALENDAR
// ══════════════════════════════════════════════════════════════
function renderCalendar() {
    const s=S(),d=CD(),cur=CD().currentDT;
    if(!calYear||!calMonth){
        calYear=cur?.year??new Date().getFullYear();
        calMonth=cur?.month??new Date().getMonth()+1;
    }
    const year=calYear,month=calMonth;
    // 일정 영역의 기본 선택 날짜는 현재 RP 날짜, 없으면 보고 있는 달의 1일이다.
    if(!schedViewDate){
        schedViewDate=cur
            ? {year:cur.year??calYear,month:cur.month,day:cur.day}
            : {year:calYear,month:calMonth,day:1};
    }
    const firstDay=new Date(year,month-1,1).getDay();
    const daysInMonth=new Date(year,month,0).getDate();
    const prevDays=new Date(year,month-1,0).getDate();
    const schedMap={};
    d.schedules.forEach(sc=>{
        if(sc.year&&sc.year!==year)return;
        if(sc.month!==month)return;
        if(!schedMap[sc.day])schedMap[sc.day]={upcoming:0,done:0};
        if(sc.done)schedMap[sc.day].done++;else schedMap[sc.day].upcoming++;
    });
    const dns=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dhdr=dns.map((d,i)=>`<div class="cal-dh${i===0?' sun':i===6?' sat':''}">${d}</div>`).join('');
    let cells='';
    for(let i=0;i<firstDay;i++)
        cells+=`<div class="cal-cell cal-other"><span class="cal-num">${prevDays-firstDay+1+i}</span></div>`;
    for(let d=1;d<=daysInMonth;d++){
        const dow=(firstDay+d-1)%7;
        const isCur=cur&&cur.month===month&&cur.day===d&&(cur.year??year)===year;
        const isSelected=schedViewDate&&schedViewDate.month===month&&schedViewDate.day===d&&(schedViewDate.year??year)===year;
        const sc=schedMap[d];
        let cls='cal-cell';
        if(dow===0)cls+=' sun';if(dow===6)cls+=' sat';if(isCur)cls+=' cal-today';if(isSelected)cls+=' cal-selected';
        let dots='';
        if(sc){if(sc.upcoming>0)dots+=`<span class="cal-dot dot-upcoming"></span>`;if(sc.done>0)dots+=`<span class="cal-dot dot-done"></span>`;}
        cells+=`<div class="${cls}" data-day="${d}" data-month="${month}"><span class="cal-num">${d}</span>${dots?`<div class="cal-dots">${dots}</div>`:''}</div>`;
    }
    const rem=(7-((firstDay+daysInMonth)%7))%7;
    for(let i=1;i<=rem;i++) cells+=`<div class="cal-cell cal-other"><span class="cal-num">${i}</span></div>`;
    const yearOpts=[...Array(20)].map((_,i)=>{const y=(cur?.year??new Date().getFullYear())-5+i;return `<option value="${y}" ${y===year?'selected':''}>${y}</option>`;}).join('');
    const monthOpts=[...Array(12)].map((_,i)=>`<option value="${i+1}" ${i+1===month?'selected':''}>${String(i+1).padStart(2,'0')}</option>`).join('');

    return `<div class="rpp-calendar-screen">
  <div class="rpp-cal-wrap">
  <div class="cal-nav">
    <button class="rpp-btn rpp-btn-xs" id="cal-prev">‹</button>
    <div class="cal-nav-selects">
      <select id="cal-year-sel" class="cal-sel">${yearOpts}</select>
      <span class="cal-nav-sep">/</span>
      <select id="cal-month-sel" class="cal-sel">${monthOpts}</select>
    </div>
    <button class="rpp-btn rpp-btn-xs" id="cal-next">›</button>
  </div>
  <div class="cal-grid">
    <div class="cal-header">${dhdr}</div>
    <div class="cal-body">${cells}</div>
  </div>
  <div class="cal-legend"><span class="cal-dot dot-upcoming"></span><span>Upcoming</span><span class="cal-dot dot-done" style="margin-left:10px"></span><span>Done</span></div>
  </div>
  <div class="rpp-calendar-schedule">${renderSchedule()}</div>
</div>`;
}

function bindCalendarEvents() {
    document.getElementById('cal-prev')?.addEventListener('click',e=>{e.stopPropagation();calMonth--;if(calMonth<1){calMonth=12;calYear--;}switchTab('calendar');});
    document.getElementById('cal-next')?.addEventListener('click',e=>{e.stopPropagation();calMonth++;if(calMonth>12){calMonth=1;calYear++;}switchTab('calendar');});
    document.getElementById('cal-year-sel')?.addEventListener('change',e=>{e.stopPropagation();calYear=+e.target.value;switchTab('calendar');});
    document.getElementById('cal-month-sel')?.addEventListener('change',e=>{e.stopPropagation();calMonth=+e.target.value;switchTab('calendar');});
    document.querySelectorAll('.cal-cell[data-day]').forEach(cell=>{
        cell.addEventListener('click',e=>{
            e.stopPropagation();
            const day=+cell.dataset.day;
            const month=+cell.dataset.month;
            const year=calYear;
            schedViewDate={month,day,year};
            switchTab('calendar');
        });
    });
}

// ══════════════════════════════════════════════════════════════
// TAB 2: SCHEDULE
// ══════════════════════════════════════════════════════════════
function getScheduleDates() {
    const d=CD(),dateSet=new Set();
    d.schedules.forEach(x=>dateSet.add(`${x.year??0}-${x.month}-${x.day}`));
    return [...dateSet].map(k=>{const p=k.split('-');return{year:+p[0]||null,month:+p[1],day:+p[2]};}).sort(cmpDate);
}

function renderSchedule() {
    const d=CD(),s=S(),cur=CD().currentDT,dates=getScheduleDates();
    if(!schedViewDate&&dates.length){
        const future=dates.filter(x=>!isPast(x,cur));
        schedViewDate=future.length?future[0]:dates[dates.length-1];
    }
    const sv=schedViewDate;
    const svItems=sv?d.schedules.filter(x=>x.month===sv.month&&x.day===sv.day&&(x.year??0)===(sv.year??0)):[];
    let prevDate=null,nextDate=null;
    if(sv&&dates.length){
        const idx=dates.findIndex(x=>x.month===sv.month&&x.day===sv.day&&(x.year??0)===(sv.year??0));
        if(idx>0)prevDate=dates[idx-1];
        if(idx<dates.length-1)nextDate=dates[idx+1];
    }
    const itemsHTML=svItems.length?svItems.map(x=>{
        const past=isPast(x,cur),today=isToday(x,cur);
        let cls='sch-card';
        if(x.done)cls+=' done';else if(today)cls+=' today';else if(past)cls+=' past';
        const src=x.source==='manual'?'Manual':'Auto';
        return `<div class="${cls}" data-id="${x.id}">
          <div class="sch-card-header">
            <label class="sch-chk-wrap"><input type="checkbox" class="sch-cb" data-id="${x.id}" ${x.done?'checked':''}><span class="sch-box"></span></label>
            <div class="sch-card-body">
              <div class="sch-card-title">${esc(x.title)}</div>
              ${x.note?`<div class="sch-card-note">${esc(x.note)}</div>`:''}
            </div>
            <div class="sch-card-actions">
              <span class="sch-src-tag">${src}</span>
              <button class="sch-edit-btn" data-id="${x.id}">✎</button>
              <button class="sch-del-btn" data-id="${x.id}">✕</button>
            </div>
          </div>
        </div>`;
    }).join(''):`<div class="rpp-empty">No schedules for this date</div>`;
    const dateLabel=sv?`${sv.month}/${sv.day}`:'—';
    const dayLabel=sv?fmtDayName(sv):'';
    return `<div class="rpp-sch-wrap">
  <div class="sch-date-nav">
    <button class="rpp-btn rpp-btn-xs sch-nav-btn" id="sch-prev-date" ${!prevDate?'disabled':''}>‹</button>
    <div class="sch-date-center"><span class="sch-date-label">${dateLabel}</span><span class="sch-day-label">${dayLabel}</span></div>
    <button class="rpp-btn rpp-btn-xs sch-nav-btn" id="sch-next-date" ${!nextDate?'disabled':''}>›</button>
  </div>
  <div class="sch-status-row">
    ${sv&&isToday(sv,cur)?'<span class="sch-status-badge today">TODAY</span>':''}
    ${sv&&isPast(sv,cur)?'<span class="sch-status-badge past">PAST</span>':''}
    <div class="rpp-spacer"></div>
    <button class="rpp-btn rpp-btn-xs" id="sch-all-btn">All Dates</button>
  </div>
  <div id="sch-items" class="sch-items">${itemsHTML}</div>
  <div class="sch-add-form">
    <div class="sch-add-row">
      <input id="sa-t" type="text" class="rpp-inp" placeholder="Add schedule..." style="flex:1">
      <button class="rpp-btn rpp-btn-primary rpp-btn-xs" id="sch-add-btn">+</button>
    </div>
    <div class="sch-add-row">
      <input id="sa-n" type="text" class="rpp-inp" placeholder="Note (optional)" style="flex:1">
    </div>
  </div>
  <div id="sch-all-wrap" class="sch-all-wrap" style="display:none">
    <div class="sch-all-header">All Schedules <button class="rpp-btn rpp-btn-xs" id="sch-all-close">✕</button></div>
    <div id="sch-all-list">${renderAllList()}</div>
  </div>
</div>`;
}

function renderAllList() {
    const d=CD(),s=S(),cur=CD().currentDT,dates=getScheduleDates();
    if(!dates.length)return '<div class="rpp-empty">No schedules</div>';
    return dates.map(dt=>{
        const items=d.schedules.filter(x=>x.month===dt.month&&x.day===dt.day&&(x.year??0)===(dt.year??0));
        return `<div class="all-date-group">
          <div class="all-date-label" data-year="${dt.year??''}" data-month="${dt.month}" data-day="${dt.day}">${dt.month}/${dt.day} ${fmtDayName(dt)}</div>
          ${items.map(x=>{
              const completed=x.done||isPast(x,cur);
              return `<div class="all-item ${completed?'done':''}" data-id="${x.id}">
            <span class="all-item-dot ${completed?'dot-done':'dot-upcoming'}"></span>
            <span class="all-item-title">${esc(x.title)}</span>
          </div>`;
          }).join('')}
        </div>`;
    }).join('');
}

function bindScheduleEvents() {
    const dates=getScheduleDates(),sv=schedViewDate;
    document.getElementById('sch-prev-date')?.addEventListener('click',e=>{
        e.stopPropagation();if(!sv)return;
        const idx=dates.findIndex(x=>x.month===sv.month&&x.day===sv.day&&(x.year??0)===(sv.year??0));
        if(idx>0){schedViewDate=dates[idx-1];switchTab('calendar');}
    });
    document.getElementById('sch-next-date')?.addEventListener('click',e=>{
        e.stopPropagation();if(!sv)return;
        const idx=dates.findIndex(x=>x.month===sv.month&&x.day===sv.day&&(x.year??0)===(sv.year??0));
        if(idx<dates.length-1){schedViewDate=dates[idx+1];switchTab('calendar');}
    });
    document.getElementById('sch-all-btn')?.addEventListener('click',e=>{e.stopPropagation();const w=document.getElementById('sch-all-wrap');if(w)w.style.display='block';});
    document.getElementById('sch-all-close')?.addEventListener('click',e=>{e.stopPropagation();const w=document.getElementById('sch-all-wrap');if(w)w.style.display='none';});
    document.querySelectorAll('.all-date-label').forEach(el=>{
        el.addEventListener('click',e=>{e.stopPropagation();schedViewDate={year:+el.dataset.year||null,month:+el.dataset.month,day:+el.dataset.day};document.getElementById('sch-all-wrap').style.display='none';switchTab('calendar');});
    });
    document.getElementById('sch-add-btn')?.addEventListener('click',e=>{e.stopPropagation();doAddSchedule();});
    document.getElementById('sa-t')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.stopPropagation();doAddSchedule();}});
    bindSchItemEvents();
}

function doAddSchedule() {
    const t=document.getElementById('sa-t')?.value.trim();
    const n=document.getElementById('sa-n')?.value.trim()||'';
    if(!t){toast('Enter a title',true);return;}
    const sv=schedViewDate;
    if(!sv){toast('Select a date first',true);return;}
    addSchedule({year:sv.year,month:sv.month,day:sv.day,title:t,note:n,source:'manual'});
    document.getElementById('sa-t').value='';document.getElementById('sa-n').value='';
    switchTab('calendar');toast('Schedule added');
}

function bindSchItemEvents() {
    document.querySelectorAll('.sch-cb').forEach(cb=>{cb.addEventListener('change',e=>{e.stopPropagation();toggleDone(cb.dataset.id);switchTab('calendar');});});
    document.querySelectorAll('.sch-del-btn').forEach(b=>{b.addEventListener('click',e=>{e.stopPropagation();removeSchedule(b.dataset.id);switchTab('calendar');});});
    document.querySelectorAll('.sch-edit-btn').forEach(b=>{b.addEventListener('click',e=>{e.stopPropagation();openSchEdit(b.dataset.id);});});
}

function openSchEdit(id) {
    document.querySelectorAll('.sch-edit-form').forEach(e=>e.remove());
    const x=CD().schedules.find(x=>x.id===id);if(!x)return;
    const form=document.createElement('div');
    form.className='sch-edit-form';
    form.innerHTML=`
      <input id="set${id}" type="text" class="rpp-inp" value="${esc(x.title)}" placeholder="Title" style="flex:1;margin-bottom:5px">
      <input id="sen${id}" type="text" class="rpp-inp" value="${esc(x.note)}" placeholder="Note" style="flex:1;margin-bottom:5px">
      <div style="display:flex;gap:6px">
        <button class="rpp-btn rpp-btn-primary rpp-btn-xs" id="sef-save-${id}">Save</button>
        <button class="rpp-btn rpp-btn-xs" id="sef-cancel-${id}">Cancel</button>
      </div>`;
    document.querySelector(`.sch-card[data-id="${id}"]`)?.insertAdjacentElement('afterend',form);
    document.getElementById(`sef-cancel-${id}`)?.addEventListener('click',e=>{e.stopPropagation();form.remove();});
    document.getElementById(`sef-save-${id}`)?.addEventListener('click',e=>{
        e.stopPropagation();
        const t=document.getElementById(`set${id}`).value.trim();
        const n=document.getElementById(`sen${id}`).value.trim();
        if(!t){toast('Title required',true);return;}
        const item=CD().schedules.find(x=>x.id===id);
        if(item){item.title=t;item.note=n;}
        sortAndAutoCheck();save();injectContext();form.remove();switchTab('calendar');toast('Updated');
    });
}

// ══════════════════════════════════════════════════════════════
// TAB 3: SETTINGS
// ══════════════════════════════════════════════════════════════
function renderSettings() {
    const s=S();
    const profiles=getCtx().extensionSettings?.connectionManager?.profiles??[];
    const profileOpts=profiles.map(p=>`<option value="${esc(p.id)}" ${p.id===s.syncProfileId?'selected':''}>${esc(p.name)}</option>`).join('');
    const previewText=buildInjectText()||'(empty)';
    const backupHTML=CD().backupSlots.length?CD().backupSlots.map(slot=>`
      <div class="backup-slot" data-id="${slot.id}">
        <div class="backup-slot-name" contenteditable="true" data-id="${slot.id}">${esc(slot.name)}</div>
        <div class="backup-slot-date">${new Date(slot.savedAt).toLocaleString()}</div>
        <div class="backup-slot-btns">
          <button class="rpp-btn rpp-btn-xs backup-restore" data-id="${slot.id}">Restore</button>
          <button class="rpp-btn rpp-btn-xs backup-delete" data-id="${slot.id}">Delete</button>
        </div>
      </div>`).join(''):'<div class="rpp-empty">No backup slots</div>';

    return `<div class="rpp-settings-wrap">
  <div class="rpp-es-section">
    <div class="rpp-es-title">🎨 테마</div>
    <div class="rpp-es-row">
      <button id="rpp-theme-toggle" class="rpp-btn rpp-btn-xs ${s.darkMode?'active-sync':''}">
        ${s.darkMode?'🌙 Dark':'☀️ Light'}
      </button>
    </div>
  </div>
  <div class="rpp-es-section">
    <div class="rpp-es-title">🕐 날짜 동기화</div>
    <div class="cal-dt-display" style="margin-bottom:10px">
      ${CD().currentDT?`<div class="cal-dt-date">${fmtDate(CD().currentDT)} <span class="cal-dt-day">${fmtDayName(CD().currentDT)}</span></div>${fmtTime(CD().currentDT)?`<div class="cal-dt-time">${fmtTime(CD().currentDT)}</div>`:''}`:
      '<div class="cal-dt-unset">날짜 미설정</div>'}
    </div>
    <div class="sync-mode-btns">
      <button id="sync-auto-btn" class="rpp-btn rpp-btn-xs ${s.syncMode==='auto'?'active-sync':''}">🟢 자동</button>
      <button id="sync-manual-btn" class="rpp-btn rpp-btn-xs">🔵 날짜 동기화</button>
      <button id="sync-off-btn" class="rpp-btn rpp-btn-xs ${s.syncMode==='off'?'active-sync-off':''}">🔴 끄기</button>
    </div>
    <div class="rpp-es-hint" style="margin-top:6px">
      ${s.syncMode==='auto'?'🟢 자동 — 메시지마다 날짜 파싱':s.syncMode==='off'?'🔴 꺼짐':'🔵 수동 전용'}
    </div>
    <div class="manual-dt-form">
      <div class="rpp-es-hint" style="margin-bottom:6px">직접 입력:</div>
      <div class="manual-dt-row">
        <input id="mdt-year" type="number" class="rpp-inp" placeholder="연도" style="width:62px">
        <span class="rpp-sep">년</span>
        <input id="mdt-month" type="number" class="rpp-inp" placeholder="월" min="1" max="12" style="width:44px">
        <span class="rpp-sep">월</span>
        <input id="mdt-day" type="number" class="rpp-inp" placeholder="일" min="1" max="31" style="width:44px">
        <span class="rpp-sep">일</span>
      </div>
      <div class="manual-dt-row"><button id="mdt-save" class="rpp-btn rpp-btn-primary rpp-btn-xs">저장</button></div>
    </div>
  </div>
  <div class="rpp-es-section">
    <div class="rpp-es-title">📋 일정 표시 개수</div>
    <div class="rpp-es-row"><span class="rpp-es-label">예정 최대</span><input type="number" id="rpp-max-upcoming" class="rpp-es-num" value="${s.maxUpcoming}" min="1" max="100"><span class="rpp-es-hint">개</span></div>
    <div class="rpp-es-row" style="margin-top:6px"><span class="rpp-es-label">지난 최대</span><input type="number" id="rpp-max-past" class="rpp-es-num" value="${s.maxPast}" min="1" max="100"><span class="rpp-es-hint">개</span></div>
  </div>
  <div class="rpp-es-section">
    <div class="rpp-es-title">📥 일정 불러오기</div>
    <div class="sch-import-btns">
      <label class="rpp-btn rpp-btn-xs sch-import-file-btn">📄 파일 불러오기<input type="file" id="sch-file-input" accept=".txt,.json" style="display:none"></label>
    </div>
    <div class="sch-import-hint">
      txt: <code>2027/5/2 : Rookie minicamp / Pittsburgh facility</code><br>
      범위: <code>2027/5/2-4 : Rookie minicamp</code><br>
      json: <code>[{"year":2027,"month":5,"day":2,"title":"제목","note":"노트"}]</code>
    </div>
    <div id="sch-scan-status" class="sch-scan-status" style="display:none"></div>
  </div>
  <div class="rpp-es-section">
    <div class="rpp-es-title">🔗 연결 프로필 (AI 파싱용)</div>
    <select id="rpp-es-profile" class="rpp-es-select" style="width:100%;max-width:100%;box-sizing:border-box"><option value="">선택 안 함</option>${profileOpts}</select>
    <div class="rpp-es-row" style="margin-top:8px">
      <button id="rpp-reset-scan-history" class="rpp-btn rpp-btn-xs">↻ 전체 채팅 다시 검사</button>
    </div>
    <div class="rpp-es-hint" style="margin-top:5px">일정은 지우지 않고, 다음 ⚡ 수집 때 현재 채팅을 전부 다시 검사합니다.</div>
  </div>
  <div class="rpp-es-section">
    <div class="rpp-es-title">✨ 일정 자동 생성 Quick Reply</div>
    <div class="rpp-es-hint" style="margin-bottom:8px">기간 선택 → AI 생성 → 일정 선택 → 달력 등록까지 실행하는 STscript입니다.</div>
    <button id="rpp-copy-quick-reply" class="rpp-btn rpp-btn-primary rpp-btn-xs">📋 빠른답장 스크립트 복사</button>
    <div class="rpp-es-hint" style="margin-top:6px">Quick Reply를 하나 만든 뒤 버튼 내용에 붙여넣으세요. 스크립트의 <code>속마음용</code>은 실제 사용할 프리셋 이름과 같아야 합니다.</div>
  </div>
  <div class="rpp-es-section">
    <div class="rpp-es-title">📤 프리셋 매크로</div>
    <div class="rpp-es-hint" style="margin-top:8px">프리셋이나 시스템 프롬프트의 원하는 위치에 매크로를 넣으세요. 별도 Depth 설정은 필요하지 않습니다.</div>
    <div class="rpp-macro-box">
      <code>{{플래너}}</code> → &lt;플래너&gt; 태그까지 포함<br>
      <code>{{스케쥴}}</code> → 일정 내용만
    </div>
  </div>
  <div class="rpp-es-section rpp-es-preview">
    <div class="rpp-es-title">👁 주입 내용 미리보기</div>
    <pre class="rpp-es-pre">${esc(previewText)}</pre>
  </div>
  <div class="rpp-es-section">
    <div class="rpp-es-title">💾 백업</div>
    <div class="backup-btn-row">
      <button class="rpp-btn rpp-btn-xs" id="backup-create-btn">+ 슬롯 저장</button>
      <button class="rpp-btn rpp-btn-xs" id="backup-export-btn">📤 파일 내보내기</button>
      <label class="rpp-btn rpp-btn-xs">📥 파일 불러오기<input type="file" id="backup-import-input" accept=".json" style="display:none"></label>
    </div>
    <div id="backup-slots">${backupHTML}</div>
  </div>
  <div class="rpp-es-section rpp-reset-section">
    <div class="rpp-es-title">⚠️ 초기화</div>
    <div class="rpp-es-hint" style="margin-bottom:8px;color:#c04040">복구할 수 없습니다.</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="rpp-btn rpp-btn-xs reset-all-btn" id="reset-all-btn">🗑 일정 전체 초기화</button>
    </div>
  </div>
</div>`;
}

function bindSettingsEvents() {
    const s=S();
    // 날짜 동기화 모드
    document.getElementById('sync-auto-btn')?.addEventListener('click',e=>{e.stopPropagation();s.syncMode='auto';save();switchTab('settings');toast('자동 동기화 켜짐');});
    // 파란 버튼 = 날짜만 동기화 (parseAllMessages)
    document.getElementById('sync-manual-btn')?.addEventListener('click',e=>{
        e.stopPropagation();
        const{dateUpdated}=parseAllMessages();
        const msg=dateUpdated?'날짜/시간 갱신됨':'감지된 날짜 없음';
        if(window.toastr)window.toastr.info(msg,'RP Planner');else alert(msg);
        switchTab('settings');
    });
    document.getElementById('sync-off-btn')?.addEventListener('click',e=>{e.stopPropagation();s.syncMode='off';save();switchTab('settings');toast('동기화 꺼짐');});
    // 수동 날짜 입력
    document.getElementById('mdt-save')?.addEventListener('click',e=>{
        e.stopPropagation();
        const year=parseInt(document.getElementById('mdt-year').value)||null;
        const month=parseInt(document.getElementById('mdt-month').value);
        const day=parseInt(document.getElementById('mdt-day').value);
        if(!month||!day){toast('월/일은 필수입니다',true);return;}
        const prev=CD().currentDT;
        CD().currentDT={year,month,day,hour:prev?.hour??null,minute:prev?.minute??null,season:prev?.season??null};
        calYear=year??calYear;calMonth=month;
        sortAndAutoCheck();save();injectContext();switchTab('settings');toast('날짜 설정 완료');
    });
    document.getElementById('rpp-theme-toggle')?.addEventListener('click',e=>{
        e.stopPropagation();
        const s=S();s.darkMode=!s.darkMode;save();
        applyTheme();switchTab('settings');
    });
    document.getElementById('rpp-max-upcoming')?.addEventListener('change',e=>{e.stopPropagation();s.maxUpcoming=parseInt(e.target.value)||20;save();injectContext();});
    document.getElementById('rpp-max-past')?.addEventListener('change',e=>{e.stopPropagation();s.maxPast=parseInt(e.target.value)||10;save();injectContext();});
    document.getElementById('sch-file-input')?.addEventListener('change',async e=>{
        e.stopPropagation();const file=e.target.files[0];if(!file)return;
        const status=document.getElementById('sch-scan-status');
        if(status){status.style.display='block';status.textContent='불러오는 중...';}
        try{
            const added=await importScheduleFile(file);
            switchTab('settings');
            if(window.toastr)window.toastr.success(`${added}개 일정을 등록했습니다`,'RP Planner');
            else toast(`${added}개 일정 등록됨`);
        }catch(err){
            if(status){status.style.display='block';status.textContent='불러오기에 실패했습니다';}
            toast('파일 불러오기 실패: '+err.message,true);
        }
    });
    document.getElementById('rpp-es-profile')?.addEventListener('change',e=>{e.stopPropagation();s.syncProfileId=e.target.value||null;save();});
    document.getElementById('rpp-reset-scan-history')?.addEventListener('click',e=>{
        e.stopPropagation();
        if(confirm('수집 기록을 초기화하고 현재 채팅을 다시 검사할까요?\n등록된 일정은 삭제되지 않습니다.')){
            CD().processedMessageHashes=[];save();toast('다음 수집에서 전체 채팅을 다시 검사합니다');
        }
    });
    document.getElementById('rpp-copy-quick-reply')?.addEventListener('click',async e=>{
        e.stopPropagation();
        try{
            await navigator.clipboard.writeText(QUICK_REPLY_SCRIPT);
            toast('빠른답장 스크립트를 복사했어요');
        }catch(err){
            const area=document.createElement('textarea');
            area.value=QUICK_REPLY_SCRIPT;area.style.position='fixed';area.style.opacity='0';
            document.body.appendChild(area);area.select();
            const ok=document.execCommand('copy');area.remove();
            toast(ok?'빠른답장 스크립트를 복사했어요':'복사에 실패했어요',!ok);
        }
    });
    document.getElementById('backup-create-btn')?.addEventListener('click',e=>{e.stopPropagation();const slot=createBackupSlot(`Backup ${new Date().toLocaleString()}`);toast(`Saved: ${slot.name}`);switchTab('settings');});
    document.getElementById('backup-export-btn')?.addEventListener('click',e=>{e.stopPropagation();exportToFile();toast('File exported');});
    document.getElementById('backup-import-input')?.addEventListener('change',async e=>{
        e.stopPropagation();const file=e.target.files[0];if(!file)return;
        try{await importFromFile(file);toast('Imported successfully');switchTab('settings');}catch(err){toast('Import failed: '+err.message,true);}
    });
    document.getElementById('reset-all-btn')?.addEventListener('click',e=>{
        e.stopPropagation();
        if(confirm('⚠️ 현재 채팅 일정 전체 초기화\n\n이 채팅의 일정, 현재 RP 날짜, 수집 기록, 내부 백업이 모두 삭제됩니다. 다른 채팅의 일정은 유지됩니다. 복구할 수 없습니다.\n계속하시겠습니까?')){clearAllData();toast('현재 채팅 일정 데이터 삭제 완료');switchTab('settings');}
    });
    document.getElementById('backup-slots')?.addEventListener('click',e=>{
        e.stopPropagation();
        const restore=e.target.closest('.backup-restore');
        if(restore){if(confirm('Restore? Current data will be overwritten.')){restoreBackupSlot(restore.dataset.id);toast('Restored');switchTab('settings');}return;}
        const del=e.target.closest('.backup-delete');
        if(del){deleteBackupSlot(del.dataset.id);switchTab('settings');}
    });
    document.querySelectorAll('.backup-slot-name[contenteditable]').forEach(el=>{
        el.addEventListener('blur',e=>{e.stopPropagation();const id=el.dataset.id;const slot=CD().backupSlots.find(x=>x.id===id);if(slot){slot.name=el.textContent.trim()||slot.name;save();}});
    });
}

// ─── 토스트 ──────────────────────────────────────────────────
let _toastTimer;
function toast(msg,err=false) {
    const el=document.getElementById('rpp-toast');if(!el)return;
    el.textContent=msg;el.className=err?'rpp-toast-err show':'show';
    clearTimeout(_toastTimer);_toastTimer=setTimeout(()=>el.className='',2800);
}

// ─── 동기화: 새/수정 메시지 지문 + 검토 후 등록 ─────────────
async function doSync(showAlert=false) {
    const c=getCtx();
    const chat=c.chat||[];

    const{dateUpdated}=parseLastOnly();
    const pending=getUnprocessedMessages(chat);
    if(!pending.length){
        const msg=dateUpdated?'날짜/시간 갱신됨 · 새로 검사할 메시지 없음':'새로 검사할 메시지 없음';
        if(showAlert&&window.toastr)window.toastr.info(msg,'RP Planner');else toast(msg);
        return;
    }

    const result=await aiParseSchedules(pending);
    if(result.error){
        if(showAlert&&window.toastr)window.toastr.error(result.error,'RP Planner');else toast(result.error,true);
        return;
    }

    const parsed=normalizeParsedSchedules(result.parsed);
    let selected=[];
    if(parsed.length){
        const reviewed=await reviewParsedSchedules(parsed);
        if(reviewed===null){
            toast('등록을 취소했어요');
            return;
        }
        selected=reviewed;
    }

    const totalAdded=applyParsedSchedules(selected);
    markMessagesProcessed(pending);
    let msg='새로운 일정 없음';
    if(dateUpdated&&totalAdded) msg=`날짜 갱신 + ${totalAdded}개 일정 감지`;
    else if(dateUpdated)        msg='날짜/시간 갱신됨';
    else if(totalAdded)         msg=`${totalAdded}개 일정 등록됨`;

    if(showAlert){if(window.toastr)window.toastr.success(msg,'RP Planner');else alert(msg);}
    else toast(msg);

    if(panelOpen&&activeTab==='calendar')switchTab('calendar');
    const badge=document.getElementById('rpp-badge');
    if(badge&&totalAdded)badge.style.display='flex';
}

// ─── 패널 열기/닫기 ──────────────────────────────────────────
let _outsideH=null;

function applyTheme() {
    const panel=document.getElementById('rpp-panel');
    if(!panel)return;
    panel.classList.toggle('rpp-dark',S().darkMode);
}

function openPanel() {
    if(document.getElementById('rpp-panel'))return;
    pruneOrphanedData();
    const wrap=document.createElement('div');
    wrap.id='rpp-wrapper';wrap.innerHTML=getPanelHTML();
    document.body.appendChild(wrap);

    document.querySelectorAll('.rpp-tab[data-tab]').forEach(b=>{b.addEventListener('click',e=>{e.stopPropagation();switchTab(b.dataset.tab);});});
    document.getElementById('rpp-close')?.addEventListener('click',e=>{e.stopPropagation();closePanel();});

    // ⚡ = AI 스케쥴 파싱
    document.getElementById('rpp-sync-btn')?.addEventListener('click',async e=>{
        e.stopPropagation();
        const btn=document.getElementById('rpp-sync-btn');
        if(btn){btn.disabled=true;btn.innerHTML='🔄';}
        try{ await doSync(true); }
        catch(err){ toast('Sync failed',true); }
        finally{ if(btn){btn.disabled=false;btn.innerHTML='⚡';} }
    });

    panelOpen=true;
    applyTheme();
    // 현재 RP 날짜로 달력 초기화
    const cur=CD().currentDT;
    if(cur){calYear=cur.year??new Date().getFullYear();calMonth=cur.month;}
    switchTab('calendar');

    setTimeout(()=>{
        _outsideH=e=>{
            if(!document.body.contains(e.target))return;
            const panel=document.getElementById('rpp-panel');
            const btn=document.getElementById('rpp-toolbar-btn');
            if(panel&&!panel.contains(e.target)&&btn&&!btn.contains(e.target)&&!e.target.closest('.rpp-review-overlay'))closePanel();
        };
        document.addEventListener('click',_outsideH);
    },80);
}

function closePanel() {
    document.getElementById('rpp-wrapper')?.remove();
    if(_outsideH){document.removeEventListener('click',_outsideH);_outsideH=null;}
    panelOpen=false;
}

function onMessageReceived() {
    const s=S();if(s.syncMode!=='auto')return;
    parseLastOnly();
    if(panelOpen&&activeTab==='calendar')switchTab('calendar');
}

function onCharacterChanged() {
    schedViewDate=null;if(panelOpen)switchTab(activeTab);
}

function registerSettingsUI() {
    const s=S();
    const profiles=getCtx().extensionSettings?.connectionManager?.profiles??[];
    const profileOpts=profiles.map(p=>`<option value="${esc(p.id)}" ${p.id===s.syncProfileId?'selected':''}>${esc(p.name)}</option>`).join('');
    const html=`<div id="rpp-ext-block" class="rpp-ext-block">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>RP Planner</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content">
          <div style="padding:8px;display:flex;flex-direction:column;gap:8px">
            <div style="font-size:0.82rem;color:var(--SmartThemeBodyColor,#ccc)">AI 파싱용 연결 프로필</div>
            <div style="display:flex;align-items:center;gap:8px">
              <select id="rpp-ext-profile" class="text_pole" style="flex:1">
                <option value="">선택 안 함</option>${profileOpts}
              </select>
            </div>
            <div style="font-size:0.76rem;color:var(--SmartThemeQuoteColor,#aaa)">나머지 설정은 패널(📆)에서</div>
          </div>
        </div>
      </div>
    </div>`;
    const container=document.getElementById('extensions_settings2')??document.getElementById('extensions_settings');
    container?.insertAdjacentHTML('beforeend',html);
    document.getElementById('rpp-ext-profile')?.addEventListener('change',e=>{S().syncProfileId=e.target.value||null;save();});
}

// ─── STscript 슬래시 명령 ────────────────────────────────────
function isoDate(year,month,day) {
    return `${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function getFutureCalendarContext() {
    const cur=CD().currentDT;
    if(!cur?.year||!cur?.month||!cur?.day){
        toast('현재 RP 날짜를 먼저 설정해주세요',true);
        return '';
    }

    const booked=[...new Set(CD().schedules
        .filter(x=>!x.done&&!isPast(x,cur))
        .map(x=>{
            let year=x.year??cur.year;
            if(x.year==null&&(x.month<cur.month||(x.month===cur.month&&x.day<cur.day)))year++;
            return isoDate(year,x.month,x.day);
        }))].sort();

    return JSON.stringify({today:isoDate(cur.year,cur.month,cur.day),booked});
}

function importCalendarLine(value) {
    const text=(Array.isArray(value)?value.join(' '):String(value??''))
        .replace(/^['"]|['"]$/g,'').trim();
    const m=text.match(/^(?:(\d{4})[.\-/])?(\d{1,2})[.\-/](\d{1,2})\s*[:：]\s*(.+)$/);
    if(!m){toast('형식 오류: M/D : 제목',true);return '0';}

    const cur=CD().currentDT;
    let year=m[1]?+m[1]:(cur?.year??null);
    const month=+m[2],day=+m[3],title=m[4].trim();
    if(!title||month<1||month>12||day<1||day>31)return '0';
    if(year&&cur?.year&&!m[1]&&(month<cur.month||(month===cur.month&&day<cur.day)))year++;

    const checkYear=year??2000;
    const valid=new Date(checkYear,month-1,day);
    if(valid.getFullYear()!==checkYear||valid.getMonth()!==month-1||valid.getDate()!==day){
        toast('존재하지 않는 날짜입니다',true);return '0';
    }

    const added=applyParsedSchedules([{year,month,day,title,note:''}]);
    if(panelOpen&&activeTab==='calendar')switchTab('calendar');
    return String(added);
}

function registerSlashCommands() {
    try{
        registerSlashCommand(
            'cal-future',
            ()=>getFutureCalendarContext(),
            [],
            '<div>Quick Reply 일정 생성용 문맥을 반환합니다. 반환값: {"today":"YYYY-MM-DD","booked":[...]}</div>',
            true,
            true,
        );
        registerSlashCommand(
            'cal-import',
            (_namedArgs,unnamedArgs)=>importCalendarLine(unnamedArgs),
            [],
            '<div><code>/cal-import M/D : 제목</code> 형식의 일정 한 건을 등록하고 0 또는 1을 반환합니다.</div>',
            true,
            true,
        );
    }catch(err){
        console.error(LOG,'슬래시 명령 등록 실패:',err);
    }
}

// ─── 매크로 등록 (프롬프트에 직접 삽입용) ────────────────────
function registerMacros() {
    try{
        MacrosParser.registerMacro('스케쥴', ()=>buildScheduleText());
        MacrosParser.registerMacro('schedule', ()=>buildScheduleText());
        MacrosParser.registerMacro('플래너', ()=>buildScheduleText());
        MacrosParser.registerMacro('planner', ()=>buildScheduleText());
    }catch(err){
        console.error(LOG,'매크로 등록 실패:',err);
    }
}

function waitForToolbar(timeoutMs=10000) {
    const find=()=>document.getElementById('extensionsMenu')??document.getElementById('top-bar');
    const existing=find();
    if(existing)return Promise.resolve(existing);
    return new Promise((resolve,reject)=>{
        const observer=new MutationObserver(()=>{
            const toolbar=find();
            if(!toolbar)return;
            clearTimeout(timer);observer.disconnect();resolve(toolbar);
        });
        const timer=setTimeout(()=>{
            observer.disconnect();reject(new Error('RP Planner toolbar container not found'));
        },timeoutMs);
        observer.observe(document.documentElement,{childList:true,subtree:true});
    });
}

function installQuickReplyPopupEnhancements() {
    if(document.documentElement.dataset.rppQuickReplyObserver==='on')return;
    document.documentElement.dataset.rppQuickReplyObserver='on';

    const selectAll=popup=>{
        if(!popup||popup.dataset.rppAutoSelected==='on')return;
        if(!popup.querySelector('.rpp-quick-schedule-picker'))return;
        popup.dataset.rppAutoSelected='on';
        popup.querySelectorAll('.scrollable-buttons-container .menu_button.toggleable:not(.toggled)')
            .forEach(button=>button.click());
    };

    document.querySelectorAll('dialog.popup').forEach(selectAll);
    new MutationObserver(mutations=>{
        for(const mutation of mutations){
            for(const node of mutation.addedNodes){
                if(!(node instanceof Element))continue;
                if(node.matches?.('dialog.popup'))selectAll(node);
                node.querySelectorAll?.('dialog.popup').forEach(selectAll);
            }
        }
    }).observe(document.body,{childList:true,subtree:true});
}

async function init() {
    if(initPromise)return initPromise;
    initPromise=(async()=>{
    ctx=SillyTavern.getContext();
    if(!ctx.extensionSettings[EXT])ctx.extensionSettings[EXT]=structuredClone(GLOBAL_DEFAULTS);
    const btnHTML=`<div id="rpp-toolbar-btn" class="rpp-toolbar-btn" title="RP Planner">
      <span>📆 스케줄러</span><span id="rpp-badge" style="display:none" class="rpp-badge-dot"></span>
    </div>`;
    const toolbar=await waitForToolbar();
    if(!document.getElementById('rpp-toolbar-btn'))toolbar.insertAdjacentHTML('beforeend',btnHTML);
    document.getElementById('rpp-toolbar-btn')?.addEventListener('click',e=>{
        e.stopPropagation();
        const badge=document.getElementById('rpp-badge');if(badge)badge.style.display='none';
        panelOpen?closePanel():openPanel();
    });
    ctx.eventSource.on(event_types.MESSAGE_RECEIVED,onMessageReceived);
    ctx.eventSource.on(event_types.CHAT_CHANGED,onCharacterChanged);
    ctx.eventSource.on(event_types.CHARACTER_EDITED,onCharacterChanged);
    if(!document.getElementById('rpp-ext-block'))registerSettingsUI();
    registerMacros();registerSlashCommands();installQuickReplyPopupEnhancements();injectContext();
    pruneOrphanedData();
    console.log(LOG,'v3.3.3 loaded');
    })();
    try{
        await initPromise;
    }catch(err){
        initPromise=null;
        throw err;
    }
}

jQuery(()=>{
    // Third-party extensions may be evaluated after APP_READY has already fired.
    // Listen for APP_READY, but also start immediately in case it already fired.
    const start=()=>init().catch(err=>console.error(LOG,'초기화 실패:',err));
    SillyTavern.getContext().eventSource.on(event_types.APP_READY,start);
    start();
});

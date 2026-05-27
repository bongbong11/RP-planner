// RP Planner v5 — SillyTavern Extension

import { event_types } from '../../../events.js';

const EXT        = 'rp-planner';
const INJECT_KEY = 'rp-planner-inject';
const LOG        = '[RPPlanner]';

let ctx = null;
function getCtx() { if(!ctx) ctx=SillyTavern.getContext(); return ctx; }

// ─── 캐릭터별 데이터 키 ──────────────────────────────────────
function getCurrentCharName() {
    const c=getCtx();
    const aiMsg=[...( c.chat||[])].reverse().find(m=>!m.is_user);
    return aiMsg?.name||'global';
}

function charKey() {
    const name=getCurrentCharName();
    return `char_${name.replace(/\s+/g,'_')}`;
}

const CHAR_DEFAULTS = {
    schedules:   [],
    characters:  [],
    loreEntries: [],
};

const GLOBAL_DEFAULTS = {
    currentDT:     null,
    syncMode:      'auto',
    syncPattern:   'Date: YYYY.MM.DD',
    injectEnabled: true,
    injectDepth:   2,
    maxUpcoming:   20,   // 예정 일정 최대 표시 개수
    maxPast:       10,   // 지난 일정 최대 표시 개수
    backupSlots:   [],
    charData:      {},
};

function S() {
    const c=getCtx();
    if(!c.extensionSettings[EXT]) c.extensionSettings[EXT]=structuredClone(GLOBAL_DEFAULTS);
    const d=c.extensionSettings[EXT];
    if(!d.charData)      d.charData={};
    if(!d.backupSlots)   d.backupSlots=[];
    if(!d.syncPattern)   d.syncPattern='Date: YYYY.MM.DD';
    if(d.syncMode===undefined) d.syncMode='auto';
    if(d.maxUpcoming===undefined) d.maxUpcoming=20;
    if(d.maxPast===undefined)     d.maxPast=10;
    return d;
}

function CD() {
    const s=S(), k=charKey();
    if(!s.charData[k]) s.charData[k]=structuredClone(CHAR_DEFAULTS);
    const d=s.charData[k];
    if(!d.characters)  d.characters=[];
    if(!d.loreEntries) d.loreEntries=[];
    // 현재 캐릭터 카드 자동 생성
    if(d.characters.length===0){
        const c=getCtx();
        const char=c.characters?.[c.characterId];
        const name=char?.name||null;
        if(name){
            d.characters.push({id:uid(),name,fields:[{key:'',val:''}]});
            save();
        }
    }
    return d;
}

function save() { getCtx().saveSettingsDebounced(); }

// ─── 유틸 ────────────────────────────────────────────────────
function uid()  { return Date.now().toString(36)+Math.random().toString(36).slice(2,5); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function cmpDate(a,b) {
    const currentYear=S().currentDT?.year??new Date().getFullYear();
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
    const dateRe  =/(?:Date|날짜)\s*:\s*(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/i;
    const timeRe  =/(?:Time|시간)\s*:\s*(\d{1,2}):(\d{2})/i;
    const dm=dateRe.exec(text);
    if(!dm)return null;
    const r={year:+dm[1],month:+dm[2],day:+dm[3],hour:null,minute:null,season:null};
    const tm=timeRe.exec(text); if(tm){r.hour=+tm[1];r.minute=+tm[2];}
    return r;
}

function parseSchedulesFromText(text,cur) {
    const found=[],seen=new Set();
    const yr=cur?.year??null;

    // 한국어
    const koRe=/(\d{1,2})월\s*(\d{1,2})일[에는]?\s*[,：:—\-]?\s*([^\n。.]{3,50})/g;
    let m;
    while((m=koRe.exec(text))!==null){
        const mo=+m[1],d=+m[2];
        if(d<1||d>31||mo<1||mo>12)continue; // 유효하지 않은 날짜 제외
        const title=m[3].trim()
            .replace(/^\*+\s*/,'').replace(/\*+\s*[—\-]\s*/g,'')
            .replace(/\(approx[^)]*\)\s*/gi,'').replace(/✅|⚠️/g,'')
            .replace(/[。.,\s]+$/,'');
        if(title.length<2)continue;
        const k=`${yr??0}-${mo}-${d}-${title}`;
        if(!seen.has(k)){seen.add(k);found.push({year:yr,month:mo,day:d,title});}
    }

    // 영어 월
    const months={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12,jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
    const enRe=/(?:\*{0,2}~?)\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?\s+(\d{1,2})(?:[–\-](\d{1,2}))?(?:st|nd|rd|th)?(?:\s*\(approx[^)]*\))?(?:\*{0,2})?\s*[:\-—]+\s*(?:\*{0,2})([^\n*✅⚠️]{2,80})/gi;
    while((m=enRe.exec(text))!==null){
        const mo=months[m[1].toLowerCase()],d=+m[2];
        const dayEnd=m[3]?+m[3]:d; // 범위 끝 날짜
        if(!mo||d<1||d>31)continue;
        const title=m[4].trim()
            .replace(/^\*+\s*/,'').replace(/\*+\s*[—\-]\s*/g,'')
            .replace(/\(approx[^)]*\)\s*/gi,'').replace(/✅|⚠️/g,'')
            .replace(/[.,\s]+$/,'');
        if(!title||title.length<2)continue;
        const k=`${yr??0}-${mo}-${d}-${title}`;
        if(!seen.has(k)){seen.add(k);found.push({year:yr,month:mo,day:d,dayEnd,title});}
    }

    // 상대날짜
    if(cur){
        const relMap={'오늘':0,'내일':1,'모레':2,'내일모레':2,'어제':-1,today:0,tomorrow:1,yesterday:-1};
        const relRe=/\b(오늘|내일모레|내일|모레|어제|today|tomorrow|yesterday)\b[에는]?\s*[,：:—\-]?\s*([^\n。.]{3,40})/gi;
        while((m=relRe.exec(text))!==null){
            const offset=relMap[m[1].toLowerCase()]??0;
            const title=m[2].trim().replace(/[.,\s]+$/,'');
            if(title.length<2)continue;
            const nd=cur.day+offset;
            const k=`${yr??0}-${cur.month}-${nd}-${title}`;
            if(!seen.has(k)){seen.add(k);found.push({year:yr,month:cur.month,day:nd,title});}
        }
    }
    return found;
}

// ─── 스케쥴 CRUD ─────────────────────────────────────────────
function sortAndAutoCheck() {
    const d=CD(),cur=S().currentDT;
    d.schedules.sort(cmpDate);
    if(cur)d.schedules.forEach(x=>{if(!x.done&&isPast(x,cur))x.done=true;});
}
function addSchedule({month,day,year=null,title,note='',source='manual'}) {
    CD().schedules.push({id:uid(),month:+month,day:+day,year:year?+year:null,title:title.trim(),note:note.trim(),done:false,source,createdAt:Date.now()});
    sortAndAutoCheck();save();injectContext();
}
function removeSchedule(id) { const d=CD();d.schedules=d.schedules.filter(x=>x.id!==id);save();injectContext(); }
function toggleDone(id)     { const d=CD();const x=d.schedules.find(x=>x.id===id);if(x){x.done=!x.done;save();injectContext();} }

// ─── 캐릭터 CRUD ─────────────────────────────────────────────
function addCharacter(name) { CD().characters.push({id:uid(),name:name.trim(),fields:[{key:'',val:''}]});save();injectContext(); }
function removeCharacter(id){ const d=CD();d.characters=d.characters.filter(x=>x.id!==id);save();injectContext(); }

// ─── 로어 CRUD ───────────────────────────────────────────────
function addLore(title,content='') { CD().loreEntries.push({id:uid(),title:title.trim(),content:content.trim()});save();injectContext(); }
function removeLore(id)            { const d=CD();d.loreEntries=d.loreEntries.filter(x=>x.id!==id);save();injectContext(); }
function updateLore(id,title,content) {
    const d=CD();const e=d.loreEntries.find(x=>x.id===id);
    if(e){e.title=title;e.content=content;save();injectContext();}
}

// ─── Context 주입 ─────────────────────────────────────────────
function buildInjectText() {
    const s=S(),d=CD(),cur=s.currentDT,lines=[];
    if(cur){
        const dt=fmtDate(cur),t=fmtTime(cur);
        const season=cur.season?` | Season: ${cur.season}`:'';
        lines.push(`[RP Current Date: ${dt}${t?` | Time: ${t}`:''}${season}]`);
    }
    const upcoming=d.schedules.filter(x=>!x.done&&(!cur||!isPast(x,cur))).slice(0,s.maxUpcoming??20);
    if(upcoming.length){
        lines.push('[RP Upcoming Schedule:');
        // 연속된 같은 제목 묶기
        const groups=[];
        for(const x of upcoming){
            const last=groups[groups.length-1];
            if(last&&last.title===x.title&&last.note===(x.note||'')&&last.month===x.month&&x.day===last.endDay+1){
                last.endDay=x.day;
            } else {
                groups.push({month:x.month,day:x.day,endDay:x.day,title:x.title,note:x.note||''});
            }
        }
        groups.forEach(g=>{
            const dateStr=g.day===g.endDay?`${g.month}/${g.day}`:`${g.month}/${g.day}~${g.endDay}`;
            const note=g.note?` (${g.note})`:'';
            lines.push(`  - ${dateStr}: ${g.title}${note}`);
        });
        lines.push(']');
    }
    const past=d.schedules.filter(x=>x.done||(cur&&isPast(x,cur))).slice(-(s.maxPast??10));
    if(past.length){
        lines.push('[RP Past Events (already occurred — do not repeat or initiate again):');
        past.forEach(x=>{const note=x.note?` (${x.note})`:'';lines.push(`  - ${x.month}/${x.day}: ${x.title}${note} — completed`);});
        lines.push(']');
    }
    d.characters.forEach(c=>{
        if(!c.name)return;
        const fl=c.fields.filter(f=>f.key&&f.val).map(f=>`  ${f.key}: ${f.val}`);
        if(fl.length){lines.push(`[Character — ${c.name}:`);lines.push(...fl);lines.push(']');}
    });
    d.loreEntries.forEach(e=>{
        if(!e.title&&!e.content)return;
        lines.push(`[${e.title||'Note'}:`);
        e.content.split('\n').forEach(l=>{if(l.trim())lines.push(`  ${l.trim()}`);});
        lines.push(']');
    });
    return lines.join('\n');
}

function injectContext() {
    const s=S(),c=getCtx();
    if(!s.injectEnabled){c.setExtensionPrompt?.(INJECT_KEY,'',1,0);return;}
    c.setExtensionPrompt?.(INJECT_KEY,buildInjectText(),1,s.injectDepth);
}

// ─── AI 스캔으로 일정 파싱 ───────────────────────────────────
async function aiScanSchedules(text) {
    const s=S();
    const profileId=s.syncProfileId;
    const c=getCtx();

    const systemPrompt=`You are a schedule extraction assistant. Extract ONLY real scheduled events/appointments from the text. 
Ignore: dialogue, narrative prose, character descriptions, weather, emotions, actions.
Return ONLY a JSON array. No explanation, no markdown, no extra text.
Format: [{"year":2027,"month":5,"day":2,"dayEnd":4,"title":"Event title","note":"optional note"}]
- year: number or null if not mentioned
- dayEnd: only if date range (e.g. May 2-4), otherwise omit
- note: location, details in parentheses, or null
- title: clean event name only, no date prefix, no markdown
If no schedules found, return []`;

    const messages=[{role:'user',content:`Extract schedules from this text:\n\n${text}`}];

    try {
        let response;
        if(profileId&&c.ConnectionManagerRequestService){
            response=await c.ConnectionManagerRequestService.sendRequest(
                profileId,messages,1500,
                {stream:false,extractData:true,includePreset:false,includeInstruct:false,systemPrompt}
            );
        } else {
            // fallback: generateRaw
            const result=await c.generateRaw({systemPrompt,prompt:text,streaming:false});
            response=result;
        }

        // 응답 텍스트 추출
        let raw='';
        if(typeof response==='string') raw=response;
        else if(response?.choices?.[0]?.message?.content) raw=response.choices[0].message.content;
        else if(response?.content?.[0]?.text) raw=response.content[0].text;
        else if(response?.content) raw=response.content;

        // JSON 파싱
        const clean=raw.replace(/```json|```/g,'').trim();
        const parsed=JSON.parse(clean);
        if(!Array.isArray(parsed)) return [];
        return parsed;
    } catch(err) {
        console.error('[RPPlanner] AI scan error:', err);
        return null; // null = 에러
    }
}

// 파싱 결과를 스케쥴에 등록 (날짜 범위 펼치기 포함)
function applyParsedSchedules(parsed) {
    const d=CD(), s=S();
    const yr=s.currentDT?.year??null;
    let added=0;
    for(const f of parsed) {
        if(!f.month||!f.day) continue;
        const startDay=+f.day;
        const endDay=f.dayEnd?+f.dayEnd:startDay;
        const year=f.year??yr;
        for(let day=startDay;day<=endDay;day++){
            if(!d.schedules.some(x=>x.month===+f.month&&x.day===day&&x.title===f.title)){
                d.schedules.push({
                    id:uid(),
                    month:+f.month,
                    day,
                    year,
                    title:(f.title||'').trim(),
                    note:(f.note||'').trim(),
                    done:false,
                    source:'ai',
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
                const d=CD(), s=S();
                const yr=s.currentDT?.year??null;
                let added=0;

                // JSON 형식 시도
                if(text.startsWith('[')||text.startsWith('{')){
                    const parsed=JSON.parse(text);
                    const arr=Array.isArray(parsed)?parsed:[parsed];
                    added=applyParsedSchedules(arr);
                } else {
                    // txt 형식: 5/2 : 제목 / 노트  또는  5/2-4 : 제목
                    const lines=text.split('\n');
                    const parsed=[];
                    for(const line of lines){
                        const l=line.trim();
                        if(!l||l.startsWith('#'))continue;
                        // 패턴: M/D 또는 M/D-D : 제목 / 노트
                        const m=l.match(/^(\d{1,2})\/(\d{1,2})(?:-(\d{1,2}))?\s*[:：]\s*(.+)/);
                        if(!m)continue;
                        const [,mo,d1,d2,rest]=m;
                        const parts=rest.split('/');
                        const title=parts[0].trim();
                        const note=parts[1]?.trim()||'';
                        parsed.push({month:+mo,day:+d1,dayEnd:d2?+d2:undefined,title,note,year:yr});
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
    // 날짜만 정규식으로 추출 (자동 동기화용)
    const c=getCtx();
    const chat=c.chat;
    if(!chat?.length)return{dateUpdated:false,added:0};
    const aiMsgs=[...chat].filter(m=>!m.is_user);
    if(!aiMsgs.length)return{dateUpdated:false,added:0};
    const s=S();
    let dateUpdated=false;
    const lastAI=aiMsgs[aiMsgs.length-1];
    const dt=parseInfoBlock(lastAI.mes||'');
    if(dt){s.currentDT=dt;dateUpdated=true;save();injectContext();}
    return{dateUpdated,added:0};
}

function parseLastOnly() {
    // 자동 동기화: 날짜만 추출
    const c=getCtx();
    const chat=c.chat;
    if(!chat?.length)return{dateUpdated:false,added:0};
    const lastAI=[...chat].reverse().find(m=>!m.is_user);
    if(!lastAI)return{dateUpdated:false,added:0};
    const s=S();
    const dt=parseInfoBlock(lastAI.mes||'');
    let dateUpdated=false;
    if(dt){s.currentDT=dt;dateUpdated=true;save();injectContext();}
    return{dateUpdated,added:0};
}

// ─── AI 스케쥴 파싱 (연결 프로필 사용) ──────────────────────
async function aiParseSchedules() {
    const s=S(), c=getCtx();
    const profileId=s.syncProfileId;
    if(!profileId){
        return{error:'연결 프로필을 먼저 설정해주세요 (설정 탭)'};
    }

    const chat=c.chat||[];
    const aiMsgs=chat.filter(m=>!m.is_user);
    if(!aiMsgs.length)return{error:'채팅 내용이 없습니다'};

    // 최근 50개 메시지로 제한
    const recentMsgs=aiMsgs.slice(-50);
    const chatText=recentMsgs.map(m=>m.mes||'').join('\n\n---\n\n');

    const curDT=s.currentDT;
    const curDateStr=curDT?`${curDT.year??''}년 ${curDT.month}월 ${curDT.day}일`:null;

    const systemPrompt=`You are a schedule extraction assistant for a roleplay chat.
${curDateStr?`Current RP date: ${curDateStr}`:''}

Your task:
1. Read the chat and extract ONLY real scheduled future events/appointments mentioned by characters
2. Ignore: past narration, general dialogue, character actions, weather descriptions, emotional states
3. Include: specific dates mentioned, appointments, meetings, events characters plan to attend
4. Calculate relative dates (tomorrow, next Tuesday, etc.) based on current RP date
5. For date ranges (May 2-4), include dayEnd field

Return ONLY a valid JSON array, no explanation, no markdown:
[{"year":2027,"month":5,"day":3,"dayEnd":5,"title":"Event name","note":"additional detail or null"}]

Rules:
- title: concise event name only (e.g. "Park visit", "Doctor appointment")  
- note: location, context, or extra detail (e.g. "festival", "with Olivia") or null
- If no schedules found, return []`;

    try {
        const messages=[{role:'user',content:chatText}];
        const response=await c.ConnectionManagerRequestService.sendRequest(
            profileId, messages, 2000,
            {stream:false, extractData:true, includePreset:true, includeInstruct:false, systemPrompt}
        );

        let raw='';
        if(typeof response==='string') raw=response;
        else if(response?.choices?.[0]?.message?.content) raw=response.choices[0].message.content;
        else if(response?.content?.[0]?.text) raw=response.content[0].text;
        else if(response?.content) raw=String(response.content);

        const clean=raw.replace(/```json|```/g,'').trim();
        const jsonMatch=clean.match(/\[[\s\S]*\]/);
        if(!jsonMatch)return{error:'AI 응답을 파싱할 수 없습니다', raw:clean.slice(0,200)};

        const parsed=JSON.parse(jsonMatch[0]);
        if(!Array.isArray(parsed))return{error:'잘못된 응답 형식'};

        const added=applyParsedSchedules(parsed);
        return{added, parsed};
    } catch(err) {
        console.error('[RPPlanner] AI parse error:', err);
        return{error:err.message||'AI 호출 실패'};
    }
}

// ─── 백업 ────────────────────────────────────────────────────
function createBackupSlot(name) {
    const s=S();
    const slot={
        id:uid(),
        name:name||`Backup ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
        data:JSON.parse(JSON.stringify({charData:s.charData,currentDT:s.currentDT})),
        savedAt:Date.now(),
    };
    s.backupSlots.unshift(slot);
    if(s.backupSlots.length>10)s.backupSlots=s.backupSlots.slice(0,10);
    save();
    return slot;
}

function restoreBackupSlot(id) {
    const s=S();
    const slot=s.backupSlots.find(x=>x.id===id);
    if(!slot)return false;
    if(slot.data.charData)s.charData=JSON.parse(JSON.stringify(slot.data.charData));
    if(slot.data.currentDT)s.currentDT=slot.data.currentDT;
    sortAndAutoCheck();save();injectContext();
    return true;
}

function deleteBackupSlot(id) {
    const s=S();s.backupSlots=s.backupSlots.filter(x=>x.id!==id);save();
}

function exportToFile() {
    const s=S();
    const data={charData:s.charData,currentDT:s.currentDT,exportedAt:Date.now()};
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download=`rp-planner-${Date.now()}.json`;
    document.body.appendChild(a);a.click();
    document.body.removeChild(a);URL.revokeObjectURL(url);
}

function importFromFile(file) {
    return new Promise((resolve,reject)=>{
        const reader=new FileReader();
        reader.onload=e=>{
            try{
                const data=JSON.parse(e.target.result);
                const s=S();
                if(data.charData)s.charData=data.charData;
                if(data.currentDT)s.currentDT=data.currentDT;
                sortAndAutoCheck();save();injectContext();
                resolve(true);
            }catch(err){reject(err);}
        };
        reader.onerror=reject;
        reader.readAsText(file);
    });
}

function clearAllData() {
    const s=S();
    s.charData={};s.currentDT=null;
    save();injectContext();
}

// ══════════════════════════════════════════════════════════════
// UI STATE
// ══════════════════════════════════════════════════════════════
let panelOpen=false,activeTab='calendar';
let calYear=null,calMonth=null;
let schedViewDate=null; // { month, day } — 스케쥴 탭 현재 보는 날짜

// ─── 패널 골격 ───────────────────────────────────────────────
function getPanelHTML() {
    return `<div id="rpp-panel">
  <div id="rpp-tabs">
    <button class="rpp-tab" data-tab="calendar" title="Calendar">📅</button>
    <button class="rpp-tab" data-tab="schedule" title="Schedule">🗓</button>
    <button class="rpp-tab" data-tab="character" title="커리어">💼</button>
    <button class="rpp-tab" data-tab="lore" title="부동산">🏠</button>
    <button class="rpp-tab" data-tab="settings" title="Settings">⚙️</button>
    <div class="rpp-tab-spacer"></div>
    <button id="rpp-inject-toggle" class="rpp-tab rpp-inject-btn" title="Toggle RP injection">📤</button>
    <button id="rpp-sync-btn" class="rpp-tab rpp-sync-icon" title="Sync now">⚡</button>
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
        case 'calendar':  c.innerHTML=renderCalendar();  bindCalendarEvents();  break;
        case 'schedule':  c.innerHTML=renderSchedule();  bindScheduleEvents();  break;
        case 'character': c.innerHTML=renderCharacter(); bindCharacterEvents(); break;
        case 'lore':      c.innerHTML=renderLore();      bindLoreEvents();      break;
        case 'settings':  c.innerHTML=renderSettings();  bindSettingsEvents();  break;
    }
    updateHeaderBtns();
}

function updateHeaderBtns() {
    const s=S();
    const injectBtn=document.getElementById('rpp-inject-toggle');
    if(injectBtn){
        injectBtn.classList.toggle('inactive',!s.injectEnabled);
        injectBtn.title=s.injectEnabled?'RP Injection ON (click to disable)':'RP Injection OFF (click to enable)';
        injectBtn.textContent=s.injectEnabled?'📤':'🔕';
    }
    const syncBtn=document.getElementById('rpp-sync-btn');
    if(syncBtn){
        syncBtn.classList.toggle('manual-mode',s.syncMode!=='auto');
    }
}

// ══════════════════════════════════════════════════════════════
// TAB 1: CALENDAR
// ══════════════════════════════════════════════════════════════
function renderCalendar() {
    const s=S(),d=CD(),cur=s.currentDT;
    if(!calYear||!calMonth){
        calYear=cur?.year??new Date().getFullYear();
        calMonth=cur?.month??new Date().getMonth()+1;
    }
    const year=calYear,month=calMonth;

    // 현재 RP 날짜 표시
    let dtDisplay='';
    if(cur){
        const dayName=fmtDayName(cur);
        const time=fmtTime(cur);
        const season=cur.season?` · ${cur.season}`:'';
        dtDisplay=`<div class="cal-dt-display">
          <div class="cal-dt-date">${fmtDate(cur)} <span class="cal-dt-day">${dayName}</span></div>
          ${time?`<div class="cal-dt-time">${time}${season}</div>`:''}
        </div>`;
    } else {
        dtDisplay=`<div class="cal-dt-display cal-dt-unset">No date synced — go to Settings</div>`;
    }

    // 달력
    const firstDay=new Date(year,month-1,1).getDay();
    const daysInMonth=new Date(year,month,0).getDate();
    const prevDays=new Date(year,month-1,0).getDate();

    // 날짜별 스케쥴 맵
    const schedMap={};
    d.schedules.forEach(sc=>{
        if(sc.year&&sc.year!==year)return;
        if(sc.month!==month)return;
        if(!schedMap[sc.day])schedMap[sc.day]={upcoming:0,done:0};
        if(sc.done)schedMap[sc.day].done++;
        else schedMap[sc.day].upcoming++;
    });

    const dns=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dhdr=dns.map((d,i)=>`<div class="cal-dh${i===0?' sun':i===6?' sat':''}">${d}</div>`).join('');

    let cells='';
    for(let i=0;i<firstDay;i++)
        cells+=`<div class="cal-cell cal-other"><span class="cal-num">${prevDays-firstDay+1+i}</span></div>`;

    for(let d=1;d<=daysInMonth;d++){
        const dow=(firstDay+d-1)%7;
        const isCur=cur&&cur.month===month&&cur.day===d&&(cur.year??year)===year;
        const sc=schedMap[d];
        let cls='cal-cell';
        if(dow===0)cls+=' sun';
        if(dow===6)cls+=' sat';
        if(isCur)cls+=' cal-today';

        let dots='';
        if(sc){
            if(sc.upcoming>0)dots+=`<span class="cal-dot dot-upcoming"></span>`;
            if(sc.done>0)dots+=`<span class="cal-dot dot-done"></span>`;
        }
        cells+=`<div class="${cls}" data-day="${d}" data-month="${month}">
          <span class="cal-num">${d}</span>
          ${dots?`<div class="cal-dots">${dots}</div>`:''}
        </div>`;
    }
    const rem=(7-((firstDay+daysInMonth)%7))%7;
    for(let i=1;i<=rem;i++)
        cells+=`<div class="cal-cell cal-other"><span class="cal-num">${i}</span></div>`;

    return `<div class="rpp-cal-wrap">
  ${dtDisplay}
  <div class="cal-nav">
    <button class="rpp-btn rpp-btn-xs" id="cal-prev">‹</button>
    <span class="cal-month-label">${year} / ${String(month).padStart(2,'0')}</span>
    <button class="rpp-btn rpp-btn-xs" id="cal-next">›</button>
  </div>
  <div class="cal-grid">
    <div class="cal-header">${dhdr}</div>
    <div class="cal-body">${cells}</div>
  </div>
  <div class="cal-legend">
    <span class="cal-dot dot-upcoming"></span><span>Upcoming</span>
    <span class="cal-dot dot-done" style="margin-left:10px"></span><span>Done</span>
  </div>
</div>`;
}

function bindCalendarEvents() {
    document.getElementById('cal-prev')?.addEventListener('click',e=>{
        e.stopPropagation();
        calMonth--;if(calMonth<1){calMonth=12;calYear--;}
        switchTab('calendar');
    });
    document.getElementById('cal-next')?.addEventListener('click',e=>{
        e.stopPropagation();
        calMonth++;if(calMonth>12){calMonth=1;calYear++;}
        switchTab('calendar');
    });
    document.querySelectorAll('.cal-cell[data-day]').forEach(cell=>{
        cell.addEventListener('click',e=>{
            e.stopPropagation();
            const day=+cell.dataset.day;
            const month=+cell.dataset.month;
            schedViewDate={month,day};
            switchTab('schedule');
        });
    });
}

// ══════════════════════════════════════════════════════════════
// TAB 2: SCHEDULE — date-by-date view
// ══════════════════════════════════════════════════════════════
function getScheduleDates() {
    const d=CD();
    const dateSet=new Set();
    d.schedules.forEach(x=>dateSet.add(`${x.year??0}-${x.month}-${x.day}`));
    return [...dateSet].map(k=>{
        const parts=k.split('-');
        return{year:+parts[0]||null,month:+parts[1],day:+parts[2]};
    }).sort(cmpDate);
}

function renderSchedule() {
    const d=CD(),s=S(),cur=s.currentDT;
    const dates=getScheduleDates();

    // 현재 보는 날짜 결정
    if(!schedViewDate&&dates.length){
        // 오늘이나 가장 가까운 미래
        const future=dates.filter(x=>!isPast(x,cur));
        schedViewDate=future.length?future[0]:dates[dates.length-1];
    }

    const sv=schedViewDate;
    const svItems=sv?d.schedules.filter(x=>x.month===sv.month&&x.day===sv.day&&(x.year??0)===(sv.year??0)):[];

    // 이전/다음 날짜 찾기
    let prevDate=null,nextDate=null;
    if(sv&&dates.length){
        const idx=dates.findIndex(x=>x.month===sv.month&&x.day===sv.day&&(x.year??0)===(sv.year??0));
        if(idx>0)prevDate=dates[idx-1];
        if(idx<dates.length-1)nextDate=dates[idx+1];
    }

    // 아이템 렌더
    const itemsHTML=svItems.length?svItems.map(x=>{
        const past=isPast(x,cur),today=isToday(x,cur);
        let cls='sch-card';
        if(x.done)cls+=' done';
        else if(today)cls+=' today';
        else if(past)cls+=' past';
        const src=x.source==='manual'?'Manual':'Auto';
        return `<div class="${cls}" data-id="${x.id}">
          <div class="sch-card-header">
            <label class="sch-chk-wrap">
              <input type="checkbox" class="sch-cb" data-id="${x.id}" ${x.done?'checked':''}>
              <span class="sch-box"></span>
            </label>
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
  <!-- 날짜 네비 -->
  <div class="sch-date-nav">
    <button class="rpp-btn rpp-btn-xs sch-nav-btn" id="sch-prev-date" ${!prevDate?'disabled':''}>‹</button>
    <div class="sch-date-center">
      <span class="sch-date-label">${dateLabel}</span>
      <span class="sch-day-label">${dayLabel}</span>
    </div>
    <button class="rpp-btn rpp-btn-xs sch-nav-btn" id="sch-next-date" ${!nextDate?'disabled':''}>›</button>
  </div>

  <!-- 상태 배지 -->
  <div class="sch-status-row">
    ${sv&&isToday(sv,cur)?'<span class="sch-status-badge today">TODAY</span>':''}
    ${sv&&isPast(sv,cur)?'<span class="sch-status-badge past">PAST</span>':''}
    <div class="rpp-spacer"></div>
    <button class="rpp-btn rpp-btn-xs" id="sch-all-btn">All Dates</button>
    <button class="rpp-btn rpp-btn-xs" id="sch-sync-btn">⚡ Sync</button>
  </div>

  <!-- 아이템 목록 -->
  <div id="sch-items" class="sch-items">${itemsHTML}</div>

  <!-- 추가 폼 -->
  <div class="sch-add-form">
    <div class="sch-add-row">
      <input id="sa-t" type="text" class="rpp-inp" placeholder="Add schedule..." style="flex:1">
      <button class="rpp-btn rpp-btn-primary rpp-btn-xs" id="sch-add-btn">+</button>
    </div>
    <div class="sch-add-row">
      <input id="sa-n" type="text" class="rpp-inp" placeholder="Note (optional)" style="flex:1">
    </div>
  </div>

  <!-- 일정 불러오기 -->
  <div class="sch-import-section">
    <div class="sch-import-title">📥 일정 불러오기</div>
    <div class="sch-import-btns">
      <label class="rpp-btn rpp-btn-xs sch-import-file-btn">
        📄 파일 불러오기
        <input type="file" id="sch-file-input" accept=".txt,.json" style="display:none">
      </label>
    </div>
    <div class="sch-import-hint">
      txt: <code>5/2 : Rookie minicamp / Pittsburgh facility</code><br>
      범위: <code>5/2-4 : Rookie minicamp</code><br>
      json: <code>[{"month":5,"day":2,"title":"제목","note":"노트"}]</code>
    </div>
    <div id="sch-scan-status" class="sch-scan-status" style="display:none"></div>
  </div>

  <!-- 전체 목록 (토글) -->
  <div id="sch-all-wrap" class="sch-all-wrap" style="display:none">
    <div class="sch-all-header">All Schedules <button class="rpp-btn rpp-btn-xs" id="sch-all-close">✕</button></div>
    <div id="sch-all-list">${renderAllList()}</div>
  </div>
</div>`;
}

function renderAllList() {
    const d=CD(),s=S(),cur=s.currentDT;
    const dates=getScheduleDates();
    if(!dates.length)return '<div class="rpp-empty">No schedules</div>';
    return dates.map(dt=>{
        const items=d.schedules.filter(x=>x.month===dt.month&&x.day===dt.day);
        return `<div class="all-date-group">
          <div class="all-date-label" data-month="${dt.month}" data-day="${dt.day}">${dt.month}/${dt.day} ${fmtDayName(dt)}</div>
          ${items.map(x=>`<div class="all-item ${x.done?'done':''}" data-id="${x.id}">
            <span class="all-item-dot ${x.done?'dot-done':'dot-upcoming'}"></span>
            <span class="all-item-title">${esc(x.title)}</span>
          </div>`).join('')}
        </div>`;
    }).join('');
}

function bindScheduleEvents() {
    const d=CD(),s=S(),cur=s.currentDT;
    const dates=getScheduleDates();
    const sv=schedViewDate;

    document.getElementById('sch-prev-date')?.addEventListener('click',e=>{
        e.stopPropagation();
        if(!sv)return;
        const idx=dates.findIndex(x=>x.month===sv.month&&x.day===sv.day);
        if(idx>0){schedViewDate=dates[idx-1];switchTab('schedule');}
    });
    document.getElementById('sch-next-date')?.addEventListener('click',e=>{
        e.stopPropagation();
        if(!sv)return;
        const idx=dates.findIndex(x=>x.month===sv.month&&x.day===sv.day);
        if(idx<dates.length-1){schedViewDate=dates[idx+1];switchTab('schedule');}
    });

    document.getElementById('sch-all-btn')?.addEventListener('click',e=>{
        e.stopPropagation();
        const w=document.getElementById('sch-all-wrap');
        if(w)w.style.display='block';
    });
    document.getElementById('sch-all-close')?.addEventListener('click',e=>{
        e.stopPropagation();
        const w=document.getElementById('sch-all-wrap');
        if(w)w.style.display='none';
    });

    // 전체 목록에서 날짜 클릭
    document.querySelectorAll('.all-date-label').forEach(el=>{
        el.addEventListener('click',e=>{
            e.stopPropagation();
            schedViewDate={month:+el.dataset.month,day:+el.dataset.day};
            document.getElementById('sch-all-wrap').style.display='none';
            switchTab('schedule');
        });
    });

    // ⚡ Sync 버튼 (스케쥴 탭)
    document.getElementById('sch-sync-btn')?.addEventListener('click',async e=>{
        e.stopPropagation();
        const btn=document.getElementById('sch-sync-btn');
        if(btn){btn.disabled=true;btn.textContent='🔄...';}
        await doSync(true);
        if(btn){btn.disabled=false;btn.textContent='⚡ Sync';}
    });

    // 파일 불러오기
    document.getElementById('sch-file-input')?.addEventListener('change',async e=>{
        e.stopPropagation();
        const file=e.target.files[0];if(!file)return;
        const status=document.getElementById('sch-scan-status');
        if(status){status.style.display='block';status.textContent='불러오는 중...';}
        try{
            const added=await importScheduleFile(file);
            switchTab('schedule');
            if(window.toastr)window.toastr.success(`${added}개 일정을 등록했습니다`,'RP Planner');
            else toast(`${added}개 일정 등록됨`);
        }catch(err){
            toast('파일 불러오기 실패: '+err.message,true);
        }
    });

    // 추가
    document.getElementById('sch-add-btn')?.addEventListener('click',e=>{
        e.stopPropagation();
        doAddSchedule();
    });
    document.getElementById('sa-t')?.addEventListener('keydown',e=>{
        if(e.key==='Enter'){e.stopPropagation();doAddSchedule();}
    });

    bindSchItemEvents();
}

function doAddSchedule() {
    const t=document.getElementById('sa-t')?.value.trim();
    const n=document.getElementById('sa-n')?.value.trim()||'';
    if(!t){toast('Enter a title',true);return;}
    const sv=schedViewDate;
    if(!sv){toast('Select a date first',true);return;}
    addSchedule({month:sv.month,day:sv.day,title:t,note:n,source:'manual'});
    document.getElementById('sa-t').value='';
    document.getElementById('sa-n').value='';
    switchTab('schedule');
    toast('Schedule added');
}

function bindSchItemEvents() {
    document.querySelectorAll('.sch-cb').forEach(cb=>{
        cb.addEventListener('change',e=>{e.stopPropagation();toggleDone(cb.dataset.id);switchTab('schedule');});
    });
    document.querySelectorAll('.sch-del-btn').forEach(b=>{
        b.addEventListener('click',e=>{e.stopPropagation();removeSchedule(b.dataset.id);switchTab('schedule');});
    });
    document.querySelectorAll('.sch-edit-btn').forEach(b=>{
        b.addEventListener('click',e=>{e.stopPropagation();openSchEdit(b.dataset.id);});
    });
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
        sortAndAutoCheck();save();injectContext();
        form.remove();switchTab('schedule');toast('Updated');
    });
}

// ══════════════════════════════════════════════════════════════
// TAB 3: CHARACTER
// ══════════════════════════════════════════════════════════════
function renderCharacter() {
    const d=CD();
    const charName=getCurrentCharName();
    // 카드 없으면 자동 생성
    if(!d.characters.length&&charName!=='global'){
        d.characters.push({id:uid(),name:charName,fields:[{key:'',val:''}]});
        save();
    }
    let html='';
    d.characters.forEach(c=>{
        html+=`<div class="chr-card" data-id="${c.id}">
          <div class="chr-card-header">
            <span class="chr-name-fixed">${esc(c.name)}</span>
            <button class="rpp-btn rpp-btn-xs chr-field-add" data-id="${c.id}">+ 항목 추가</button>
          </div>
          <div class="chr-fields">
            ${c.fields.map((f,i)=>`<div class="chr-field-row">
              <input type="text" class="rpp-inp chr-fkey" data-cid="${c.id}" data-idx="${i}" value="${esc(f.key)}" placeholder="항목명" style="width:80px;flex-shrink:0">
              <textarea class="rpp-textarea chr-fval" data-cid="${c.id}" data-idx="${i}" placeholder="내용" style="flex:1;min-height:60px;resize:vertical">${esc(f.val)}</textarea>
              <button class="chr-field-del rpp-btn rpp-btn-xs" data-cid="${c.id}" data-idx="${i}" style="align-self:flex-start">−</button>
            </div>`).join('')}
          </div>
          <div class="chr-card-footer">
            <button class="rpp-btn rpp-btn-primary rpp-btn-xs chr-save-btn" data-id="${c.id}">Save</button>
          </div>
        </div>`;
    });
    return `<div class="rpp-chr-wrap">
      <div class="chr-context-label">📌 ${esc(charName)}</div>
      <div id="chr-list">${html}</div>
    </div>`;
}

function bindCharacterEvents() {
    document.getElementById('chr-list')?.addEventListener('click',e=>{
        e.stopPropagation();
        const addField=e.target.closest('.chr-field-add');
        if(addField){const d=CD();const c=d.characters.find(x=>x.id===addField.dataset.id);if(c){c.fields.push({key:'',val:''});save();switchTab('character');}return;}
        const delField=e.target.closest('.chr-field-del');
        if(delField){const d=CD();const c=d.characters.find(x=>x.id===delField.dataset.cid);if(c){c.fields.splice(+delField.dataset.idx,1);save();injectContext();switchTab('character');}return;}
        const sv=e.target.closest('.chr-save-btn');
        if(sv){
            const id=sv.dataset.id;const d=CD();const c=d.characters.find(x=>x.id===id);if(!c)return;
            const keys=document.querySelectorAll(`.chr-fkey[data-cid="${id}"]`);
            const vals=document.querySelectorAll(`.chr-fval[data-cid="${id}"]`);
            c.fields=[];keys.forEach((k,i)=>c.fields.push({key:k.value.trim(),val:vals[i].value.trim()}));
            c.fields=c.fields.filter(f=>f.key||f.val);
            save();injectContext();toast('Saved');
        }
    });
}

// ══════════════════════════════════════════════════════════════
// TAB 4: LORE
// ══════════════════════════════════════════════════════════════
function renderLore() {
    const d=CD();
    const charName=getCurrentCharName();
    let html='';
    d.loreEntries.forEach(e=>{
        html+=`<div class="lore-card" data-id="${e.id}">
          <div class="lore-card-header">
            <input type="text" class="rpp-inp lore-title-inp" data-id="${e.id}" value="${esc(e.title)}" placeholder="Title" style="flex:1">
            <button class="lore-del-btn rpp-btn rpp-btn-xs" data-id="${e.id}">Delete</button>
          </div>
          <textarea class="rpp-textarea lore-content" data-id="${e.id}" placeholder="Content...">${esc(e.content)}</textarea>
          <div class="lore-card-footer">
            <button class="rpp-btn rpp-btn-primary rpp-btn-xs lore-save-btn" data-id="${e.id}">Save</button>
          </div>
        </div>`;
    });
    if(!d.loreEntries.length)html='<div class="rpp-empty">No lore entries</div>';
    return `<div class="rpp-lore-wrap">
      <div class="chr-context-label">📌 ${esc(charName)}</div>
      <div class="lore-top-bar">
        <input id="lore-new-title" type="text" class="rpp-inp" placeholder="Title" style="flex:1">
        <button class="rpp-btn rpp-btn-primary rpp-btn-xs" id="lore-add-btn">Add</button>
      </div>
      <div id="lore-list">${html}</div>
    </div>`;
}

function bindLoreEvents() {
    document.getElementById('lore-add-btn')?.addEventListener('click',e=>{
        e.stopPropagation();
        const title=document.getElementById('lore-new-title').value.trim();
        addLore(title,'');document.getElementById('lore-new-title').value='';switchTab('lore');toast('Entry added');
    });
    document.getElementById('lore-new-title')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.stopPropagation();document.getElementById('lore-add-btn')?.click();}});
    document.getElementById('lore-list')?.addEventListener('click',e=>{
        e.stopPropagation();
        const del=e.target.closest('.lore-del-btn');
        if(del){removeLore(del.dataset.id);switchTab('lore');toast('Deleted');return;}
        const sv=e.target.closest('.lore-save-btn');
        if(sv){
            const id=sv.dataset.id;
            const title=document.querySelector(`.lore-title-inp[data-id="${id}"]`)?.value.trim()||'';
            const content=document.querySelector(`.lore-content[data-id="${id}"]`)?.value.trim()||'';
            updateLore(id,title,content);toast('Saved');
        }
    });
}

// ══════════════════════════════════════════════════════════════
// TAB 5: SETTINGS
// ══════════════════════════════════════════════════════════════
function renderSettings() {
    const s=S();
    const profiles=getCtx().extensionSettings?.connectionManager?.profiles??[];
    const profileOpts=profiles.map(p=>`<option value="${esc(p.id)}" ${p.id===s.syncProfileId?'selected':''}>${esc(p.name)}</option>`).join('');
    const previewText=buildInjectText()||'(empty)';

    // 백업 슬롯
    const backupHTML=s.backupSlots.length?s.backupSlots.map(slot=>`
      <div class="backup-slot" data-id="${slot.id}">
        <div class="backup-slot-name" contenteditable="true" data-id="${slot.id}">${esc(slot.name)}</div>
        <div class="backup-slot-date">${new Date(slot.savedAt).toLocaleString()}</div>
        <div class="backup-slot-btns">
          <button class="rpp-btn rpp-btn-xs backup-restore" data-id="${slot.id}">Restore</button>
          <button class="rpp-btn rpp-btn-xs backup-delete" data-id="${slot.id}">Delete</button>
        </div>
      </div>`).join(''):'<div class="rpp-empty">No backup slots</div>';

    // 동기화 상태
    const syncStateLabel=s.syncMode==='auto'?'🟢 Auto sync active':s.syncMode==='manual'?'🔵 Manual only':'🔴 Sync off';

    return `<div class="rpp-settings-wrap">

  <!-- 날짜 동기화 -->
  <div class="rpp-es-section">
    <div class="rpp-es-title">🕐 날짜 동기화</div>
    <div class="cal-dt-display" style="margin-bottom:10px">
      ${S().currentDT?`<div class="cal-dt-date">${fmtDate(S().currentDT)} <span class="cal-dt-day">${fmtDayName(S().currentDT)}</span></div>${fmtTime(S().currentDT)?`<div class="cal-dt-time">${fmtTime(S().currentDT)}</div>`:''}`:
      '<div class="cal-dt-unset">날짜 미설정</div>'}
    </div>
    <div class="sync-mode-btns">
      <button id="sync-auto-btn" class="rpp-btn rpp-btn-xs ${s.syncMode==='auto'?'active-sync':''}">🟢 자동</button>
      <button id="sync-manual-btn" class="rpp-btn rpp-btn-xs">🔵 지금 동기화</button>
      <button id="sync-off-btn" class="rpp-btn rpp-btn-xs ${s.syncMode==='off'?'active-sync-off':''}">🔴 끄기</button>
    </div>
    <div class="rpp-es-hint" style="margin-top:6px">
      ${s.syncMode==='auto'?'🟢 자동 — 메시지마다 자동 파싱':s.syncMode==='off'?'🔴 꺼짐 — 동기화 없음':'🔵 수동 전용'}
    </div>
    <!-- 수동 날짜 직접 입력 -->
    <div class="manual-dt-form">
      <div class="rpp-es-hint" style="margin-bottom:6px">직접 입력:</div>
      <div class="manual-dt-row">
        <input id="mdt-year"  type="number" class="rpp-inp" placeholder="연도" style="width:62px">
        <span class="rpp-sep">년</span>
        <input id="mdt-month" type="number" class="rpp-inp" placeholder="월" min="1" max="12" style="width:44px">
        <span class="rpp-sep">월</span>
        <input id="mdt-day"   type="number" class="rpp-inp" placeholder="일" min="1" max="31" style="width:44px">
        <span class="rpp-sep">일</span>
      </div>
      <div class="manual-dt-row">
        <button id="mdt-save" class="rpp-btn rpp-btn-primary rpp-btn-xs">저장</button>
      </div>
    </div>
  </div>

  <!-- 일정 표시 개수 -->
  <div class="rpp-es-section">
    <div class="rpp-es-title">📋 일정 표시 개수</div>
    <div class="rpp-es-row">
      <span class="rpp-es-label">예정 최대</span>
      <input type="number" id="rpp-max-upcoming" class="rpp-es-num" value="${s.maxUpcoming}" min="1" max="100">
      <span class="rpp-es-hint">개</span>
    </div>
    <div class="rpp-es-row" style="margin-top:6px">
      <span class="rpp-es-label">지난 최대</span>
      <input type="number" id="rpp-max-past" class="rpp-es-num" value="${s.maxPast}" min="1" max="100">
      <span class="rpp-es-hint">개</span>
    </div>
  </div>

  <!-- 연결 프로필 -->
  <div class="rpp-es-section">
    <div class="rpp-es-title">🔗 연결 프로필 (동기화용)</div>
    <select id="rpp-es-profile" class="rpp-es-select">
      <option value="">메인 API 따라가기</option>
      ${profileOpts}
    </select>
  </div>

  <!-- 롤플 반영 -->
  <div class="rpp-es-section">
    <div class="rpp-es-title">📤 롤플 반영</div>
    <div class="rpp-es-row">
      <span class="rpp-es-label">Context 주입</span>
      <button id="rpp-inject-toggle-settings" class="rpp-btn rpp-btn-xs ${s.injectEnabled?'inject-on':'inject-off'}">
        ${s.injectEnabled?'켜짐 ✓':'꺼짐 ✗'}
      </button>
    </div>
    <div class="rpp-es-row" style="margin-top:6px">
      <span class="rpp-es-label">Depth</span>
      <input type="number" id="rpp-es-depth" class="rpp-es-num" value="${s.injectDepth}" min="0" max="10">
      <span class="rpp-es-hint">0=시스템끝, 2=마지막 메시지 앞</span>
    </div>
  </div>

  <!-- 주입 미리보기 -->
  <div class="rpp-es-section rpp-es-preview">
    <div class="rpp-es-title">👁 주입 내용 미리보기</div>
    <pre class="rpp-es-pre">${esc(previewText)}</pre>
  </div>

  <!-- 백업 -->
  <div class="rpp-es-section">
    <div class="rpp-es-title">💾 백업</div>
    <div class="backup-btn-row">
      <button class="rpp-btn rpp-btn-xs" id="backup-create-btn">+ 슬롯 저장</button>
      <button class="rpp-btn rpp-btn-xs" id="backup-export-btn">📤 파일 내보내기</button>
      <label class="rpp-btn rpp-btn-xs" id="backup-import-label">📥 파일 불러오기<input type="file" id="backup-import-input" accept=".json" style="display:none"></label>
    </div>
    <div id="backup-slots">${backupHTML}</div>
  </div>

  <!-- 전체 초기화 -->
  <div class="rpp-es-section rpp-reset-section">
    <div class="rpp-es-title">⚠️ 전체 초기화</div>
    <div class="rpp-es-hint" style="margin-bottom:8px;color:#c04040">
      모든 스케쥴, 커리어, 부동산, 날짜 데이터가 삭제됩니다. 복구할 수 없습니다.
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="rpp-btn rpp-btn-xs reset-all-btn" id="reset-all-btn">🗑 전체 초기화</button>
      <button class="rpp-btn rpp-btn-xs reset-cal-btn" id="reset-cal-btn">📅 스케쥴만 삭제</button>
    </div>
  </div>

</div>`;
}

function bindSettingsEvents() {
    const s=S();

    // 동기화 모드
    document.getElementById('sync-auto-btn')?.addEventListener('click',e=>{
        e.stopPropagation();s.syncMode='auto';save();switchTab('settings');toast('자동 동기화 켜짐');
    });
    document.getElementById('sync-manual-btn')?.addEventListener('click',async e=>{
        e.stopPropagation();
        const btn=document.getElementById('sync-manual-btn');
        if(btn){btn.disabled=true;btn.textContent='🔄 분석 중...';}
        const{dateUpdated}=parseLastOnly();
        const result=await aiParseSchedules();
        if(btn){btn.disabled=false;btn.textContent='🔵 지금 동기화';}
        let msg='';
        if(result.error){
            msg=`오류: ${result.error}`;
            if(window.toastr)window.toastr.error(msg,'RP Planner');
            else alert(msg);
        } else {
            const added=result.added||0;
            if(dateUpdated&&added)     msg=`날짜 갱신 + ${added}개 일정 감지`;
            else if(dateUpdated)       msg='날짜/시간 갱신됨';
            else if(added)             msg=`${added}개 일정 감지됨`;
            else                       msg='새로운 일정 없음';
            if(window.toastr)window.toastr.success(msg,'RP Planner');
            else alert(msg);
        }
        switchTab('settings');
    });
    document.getElementById('sync-off-btn')?.addEventListener('click',e=>{
        e.stopPropagation();s.syncMode='off';save();switchTab('settings');toast('동기화 꺼짐');
    });

    // 수동 날짜 직접 입력
    document.getElementById('mdt-save')?.addEventListener('click',e=>{
        e.stopPropagation();
        const year  =parseInt(document.getElementById('mdt-year').value)||null;
        const month =parseInt(document.getElementById('mdt-month').value);
        const day   =parseInt(document.getElementById('mdt-day').value);
        if(!month||!day){toast('월/일은 필수입니다',true);return;}
        // 기존 시간/계절은 유지
        const prev=s.currentDT;
        s.currentDT={year,month,day,hour:prev?.hour??null,minute:prev?.minute??null,season:prev?.season??null};
        sortAndAutoCheck();save();injectContext();
        switchTab('settings');toast('날짜 설정 완료');
    });

    // 일정 표시 개수
    document.getElementById('rpp-max-upcoming')?.addEventListener('change',e=>{
        e.stopPropagation();s.maxUpcoming=parseInt(e.target.value)||20;save();injectContext();
    });
    document.getElementById('rpp-max-past')?.addEventListener('change',e=>{
        e.stopPropagation();s.maxPast=parseInt(e.target.value)||10;save();injectContext();
    });

    // 연결 프로필
    document.getElementById('rpp-es-profile')?.addEventListener('change',e=>{
        e.stopPropagation();s.syncProfileId=e.target.value||null;save();
    });

    // 주입 토글
    document.getElementById('rpp-inject-toggle-settings')?.addEventListener('click',e=>{
        e.stopPropagation();
        s.injectEnabled=!s.injectEnabled;save();injectContext();updateHeaderBtns();switchTab('settings');
    });

    // depth
    document.getElementById('rpp-es-depth')?.addEventListener('change',e=>{
        e.stopPropagation();s.injectDepth=parseInt(e.target.value)||2;save();injectContext();
    });

    // 백업 슬롯 생성
    document.getElementById('backup-create-btn')?.addEventListener('click',e=>{
        e.stopPropagation();
        const slot=createBackupSlot(`Backup ${new Date().toLocaleString()}`);
        toast(`Saved: ${slot.name}`);switchTab('settings');
    });

    // 파일 내보내기
    document.getElementById('backup-export-btn')?.addEventListener('click',e=>{
        e.stopPropagation();exportToFile();toast('File exported');
    });

    // 파일 불러오기
    document.getElementById('backup-import-input')?.addEventListener('change',async e=>{
        e.stopPropagation();
        const file=e.target.files[0];if(!file)return;
        try{
            await importFromFile(file);
            toast('Imported successfully');switchTab('settings');
        }catch(err){toast('Import failed: '+err.message,true);}
    });

    // 전체 초기화
    document.getElementById('reset-all-btn')?.addEventListener('click',e=>{
        e.stopPropagation();
        if(confirm('⚠️ 전체 초기화\n\n모든 스케쥴, 커리어, 부동산, 날짜 데이터가 삭제됩니다.\n이 작업은 복구할 수 없습니다.\n\n계속하시겠습니까?')){
            clearAllData();
            toast('전체 초기화 완료');
            switchTab('settings');
        }
    });

    // 스케쥴만 삭제
    document.getElementById('reset-cal-btn')?.addEventListener('click',e=>{
        e.stopPropagation();
        if(confirm('📅 스케쥴만 삭제\n\n현재 캐릭터의 스케쥴 데이터만 삭제됩니다.\n커리어/부동산 데이터는 유지됩니다.\n\n계속하시겠습니까?')){
            const d=CD();
            d.schedules=[];
            save();injectContext();
            toast('스케쥴 삭제 완료');
            switchTab('settings');
        }
    });

    // 슬롯 복원/삭제
    document.getElementById('backup-slots')?.addEventListener('click',e=>{
        e.stopPropagation();
        const restore=e.target.closest('.backup-restore');
        if(restore){
            if(confirm('Restore this backup? Current data will be overwritten.')){
                restoreBackupSlot(restore.dataset.id);toast('Restored');switchTab('settings');
            }
            return;
        }
        const del=e.target.closest('.backup-delete');
        if(del){deleteBackupSlot(del.dataset.id);switchTab('settings');return;}
    });

    // 슬롯 이름 편집
    document.querySelectorAll('.backup-slot-name[contenteditable]').forEach(el=>{
        el.addEventListener('blur',e=>{
            e.stopPropagation();
            const id=el.dataset.id;
            const slot=s.backupSlots.find(x=>x.id===id);
            if(slot){slot.name=el.textContent.trim()||slot.name;save();}
        });
    });
}

// ─── 토스트 ──────────────────────────────────────────────────
let _toastTimer;
function toast(msg,err=false) {
    const el=document.getElementById('rpp-toast');if(!el)return;
    el.textContent=msg;el.className=err?'rpp-toast-err show':'show';
    clearTimeout(_toastTimer);_toastTimer=setTimeout(()=>el.className='',2800);
}

// ─── 동기화 실행 ─────────────────────────────────────────────
async function doSync(showAlert=false) {
    // 날짜 먼저 정규식으로
    const{dateUpdated}=parseLastOnly();

    // 스케쥴은 AI로
    const result=await aiParseSchedules();

    let msg='';
    if(result.error){
        msg=`오류: ${result.error}`;
        if(showAlert){
            if(window.toastr)window.toastr.error(msg,'RP Planner');
            else alert(msg);
        } else toast(msg,true);
        return;
    }

    const added=result.added||0;
    if(dateUpdated&&added)     msg=`날짜 갱신 + ${added}개 일정 감지`;
    else if(dateUpdated)       msg='날짜/시간 갱신됨';
    else if(added)             msg=`${added}개 일정 감지됨`;
    else                       msg='새로운 일정 없음';

    if(showAlert){
        if(window.toastr)window.toastr.success(msg,'RP Planner');
        else alert(msg);
    } else toast(msg);

    if(panelOpen){
        if(activeTab==='calendar')switchTab('calendar');
        else if(activeTab==='schedule')switchTab('schedule');
    }
    const badge=document.getElementById('rpp-badge');
    if(badge&&added)badge.style.display='flex';
}

// ─── 패널 열기/닫기 ──────────────────────────────────────────
let _outsideH=null;

function openPanel() {
    if(document.getElementById('rpp-panel'))return;
    const wrap=document.createElement('div');
    wrap.id='rpp-wrapper';wrap.innerHTML=getPanelHTML();
    document.body.appendChild(wrap);

    document.querySelectorAll('.rpp-tab[data-tab]').forEach(b=>{
        b.addEventListener('click',e=>{e.stopPropagation();switchTab(b.dataset.tab);});
    });
    document.getElementById('rpp-close')?.addEventListener('click',e=>{e.stopPropagation();closePanel();});

    // ⚡ 수동 동기화
    document.getElementById('rpp-sync-btn')?.addEventListener('click',e=>{
        e.stopPropagation();doSync(true);
    });

    // 📤 주입 토글
    document.getElementById('rpp-inject-toggle')?.addEventListener('click',e=>{
        e.stopPropagation();
        const s=S();s.injectEnabled=!s.injectEnabled;
        save();injectContext();updateHeaderBtns();
        toast(s.injectEnabled?'RP Injection ON':'RP Injection OFF');
    });

    panelOpen=true;
    switchTab('calendar');

    setTimeout(()=>{
        _outsideH=e=>{
            // DOM에서 제거된 요소 클릭은 무시 (재렌더링 버그 방지)
            if(!document.body.contains(e.target))return;
            const panel=document.getElementById('rpp-panel');
            const btn=document.getElementById('rpp-toolbar-btn');
            if(panel&&!panel.contains(e.target)&&btn&&!btn.contains(e.target))closePanel();
        };
        document.addEventListener('click',_outsideH);
    },80);
}

function closePanel() {
    document.getElementById('rpp-wrapper')?.remove();
    if(_outsideH){document.removeEventListener('click',_outsideH);_outsideH=null;}
    panelOpen=false;
}

// ─── 메시지 수신 훅 ──────────────────────────────────────────
function onMessageReceived() {
    const s=S();
    if(s.syncMode!=='auto')return;
    parseLastOnly();
    if(panelOpen){
        if(activeTab==='calendar')switchTab('calendar');
        else if(activeTab==='schedule')switchTab('schedule');
    }
}

// ─── 캐릭터 전환 훅 ──────────────────────────────────────────
function onCharacterChanged() {
    schedViewDate=null;
    if(panelOpen)switchTab(activeTab);
}

// ─── Extensions 설정 탭 등록 ─────────────────────────────────
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
            <div style="font-size:0.82rem;color:var(--SmartThemeBodyColor,#ccc)">
              스케쥴 AI 파싱에 사용할 연결 프로필을 선택하세요.
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <label style="font-size:0.82rem;color:var(--SmartThemeBodyColor,#ccc);white-space:nowrap">연결 프로필</label>
              <select id="rpp-ext-profile" class="text_pole" style="flex:1">
                <option value="">선택 안 함</option>
                ${profileOpts}
              </select>
            </div>
            <div style="font-size:0.76rem;color:var(--SmartThemeQuoteColor,#aaa)">
              나머지 설정은 패널(📆)에서 확인하세요.
            </div>
          </div>
        </div>
      </div>
    </div>`;
    const container=document.getElementById('extensions_settings2')??document.getElementById('extensions_settings');
    container?.insertAdjacentHTML('beforeend',html);

    document.getElementById('rpp-ext-profile')?.addEventListener('change',e=>{
        S().syncProfileId=e.target.value||null;
        save();
        toast('연결 프로필 저장됨');
    });
}

// ─── 초기화 ──────────────────────────────────────────────────
async function init() {
    ctx=SillyTavern.getContext();
    if(!ctx.extensionSettings[EXT])ctx.extensionSettings[EXT]=structuredClone(GLOBAL_DEFAULTS);

    const btnHTML=`<div id="rpp-toolbar-btn" class="rpp-toolbar-btn" title="RP Planner">
      <span>📆</span><span id="rpp-badge" style="display:none" class="rpp-badge-dot"></span>
    </div>`;
    const toolbar=document.getElementById('extensionsMenu')??document.getElementById('top-bar');
    toolbar?.insertAdjacentHTML('beforeend',btnHTML);

    document.getElementById('rpp-toolbar-btn')?.addEventListener('click',e=>{
        e.stopPropagation();
        const badge=document.getElementById('rpp-badge');if(badge)badge.style.display='none';
        panelOpen?closePanel():openPanel();
    });

    ctx.eventSource.on(event_types.MESSAGE_RECEIVED,onMessageReceived);
    ctx.eventSource.on(event_types.CHAT_CHANGED,onCharacterChanged);
    ctx.eventSource.on(event_types.CHARACTER_EDITED,onCharacterChanged);

    registerSettingsUI();
    injectContext();
    console.log(LOG,'v5 loaded');
}

jQuery(async()=>{
    const context=SillyTavern.getContext();
    context.eventSource.on(event_types.APP_READY,async()=>{await init();});
});

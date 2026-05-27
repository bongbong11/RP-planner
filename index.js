// RP Planner — SillyTavern Extension v3
// 변경사항:
//   - 동기화(파싱) / 주입(롤플반영) 완전 분리
//   - 번개버튼 → 수동 동기화 버튼
//   - Past Events / Upcoming Schedule 분리 주입
//   - Extensions 설정탭: 연결프로필 선택, 자동/수동 동기화, 주입 토글
//   - 연결프로필: extension_settings.connectionManager.profiles 에서 읽어옴

import { saveSettingsDebounced, getContext, eventSource, event_types } from '../../../../script.js';
import { extension_settings, setExtensionPrompt } from '../../../extensions.js';
const extension_prompt_types = { IN_CHAT: 1, BEFORE_PROMPT: 0, IN_PROMPT: 2 };

const EXT        = 'rp-planner';
const INJECT_KEY = 'rp-planner-inject';
const LOG        = '[RPPlanner]';

// ─── 기본 설정 ────────────────────────────────────────────────
const DEFAULTS = {
    currentDT:       null,   // { year, month, day, hour, minute, season }
    schedules:       [],     // [{ id, month, day, year?, title, note, done, source }]
    characters:      [],     // [{ id, name, fields: [{key,val}] }]
    loreEntries:     [],     // [{ id, title, content }]
    // 동기화 설정
    syncProfileId:   null,   // 연결 프로필 id (null = 미선택)
    autoSync:        true,   // true = 메시지 수신마다 자동 동기화
    // 주입 설정
    injectEnabled:   true,   // 롤플 반영 토글
    injectDepth:     2,
};

function S(){
    if(!extension_settings[EXT]) extension_settings[EXT]=structuredClone(DEFAULTS);
    const d=extension_settings[EXT];
    // 마이그레이션
    if(!d.characters)    d.characters=[];
    if(!d.loreEntries)   d.loreEntries=[];
    if(d.autoSync===undefined)  d.autoSync=true;
    if(d.syncProfileId===undefined) d.syncProfileId=null;
    return d;
}

// ─── 유틸 ────────────────────────────────────────────────────
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,5); }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function cmpDate(a,b){
    const ay=a.year??0,by=b.year??0;
    if(ay!==by) return ay-by;
    if(a.month!==b.month) return a.month-b.month;
    return a.day-b.day;
}
function isPast(s,cur){ return cur?cmpDate(s,cur)<0:false; }
function isToday(s,cur){ return cur?cmpDate(s,cur)===0:false; }

function fmtDate(d){
    if(!d) return '—';
    const y=d.year?`${d.year}.`:'';
    return `${y}${String(d.month).padStart(2,'0')}.${String(d.day).padStart(2,'0')}`;
}
function fmtTime(d){
    if(!d||d.hour==null) return '';
    return `${String(d.hour).padStart(2,'0')}:${String(d.minute??0).padStart(2,'0')}`;
}

// ─── 연결 프로필 목록 가져오기 ───────────────────────────────
function getConnectionProfiles(){
    return extension_settings?.connectionManager?.profiles ?? [];
}

// ─── 파싱: 인포블럭 ──────────────────────────────────────────
function parseInfoBlock(text){
    const dateRe  =/(?:Date|날짜)\s*:\s*(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/i;
    const timeRe  =/(?:Time|시간)\s*:\s*(\d{1,2}):(\d{2})/i;
    const seasonRe=/(?:Season|계절)\s*:\s*([^\|\n\r]{1,20})/i;
    const dm=dateRe.exec(text);
    if(!dm) return null;
    const r={year:+dm[1],month:+dm[2],day:+dm[3],hour:null,minute:null,season:null};
    const tm=timeRe.exec(text); if(tm){r.hour=+tm[1];r.minute=+tm[2];}
    const sm=seasonRe.exec(text); if(sm) r.season=sm[1].trim();
    return r;
}

// ─── 파싱: 스케쥴 텍스트 ────────────────────────────────────
function parseSchedulesFromText(text,cur){
    const found=[],seen=new Set();
    // 한국어 월/일
    const koRe=/(\d{1,2})월\s*(\d{1,2})일[에는]?\s*[,：:—\-]?\s*([^\n。.]{3,40})/g;
    let m;
    while((m=koRe.exec(text))!==null){
        const mo=+m[1],d=+m[2];
        const title=m[3].trim().replace(/[。.,\s]+$/,'');
        if(title.length<2) continue;
        const k=`${mo}-${d}-${title}`;
        if(!seen.has(k)){seen.add(k);found.push({month:mo,day:d,title});}
    }
    // 영어 월 이름
    const months={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12,jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
    const enRe=/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b[,\s]*([^\n.]{3,40})?/gi;
    while((m=enRe.exec(text))!==null){
        const mo=months[m[1].toLowerCase()],d=+m[2];
        const title=(m[3]||'').trim().replace(/[.,\s]+$/,'');
        if(!title||title.length<2) continue;
        const k=`${mo}-${d}-${title}`;
        if(!seen.has(k)){seen.add(k);found.push({month:mo,day:d,title});}
    }
    // 상대 날짜
    if(cur){
        const relMap={'오늘':0,'내일':1,'모레':2,'내일모레':2,'어제':-1,today:0,tomorrow:1,yesterday:-1};
        const relRe=/\b(오늘|내일모레|내일|모레|어제|today|tomorrow|yesterday)\b[에는]?\s*[,：:—\-]?\s*([^\n。.]{3,30})/gi;
        while((m=relRe.exec(text))!==null){
            const offset=relMap[m[1].toLowerCase()]??0;
            const title=m[2].trim().replace(/[.,\s]+$/,'');
            if(title.length<2) continue;
            const nd=cur.day+offset;
            const k=`${cur.month}-${nd}-${title}`;
            if(!seen.has(k)){seen.add(k);found.push({month:cur.month,day:nd,title});}
        }
    }
    return found;
}

// ─── 스케쥴 CRUD ─────────────────────────────────────────────
function sortAndAutoCheck(){
    const s=S();
    s.schedules.sort(cmpDate);
    if(s.currentDT) s.schedules.forEach(x=>{if(!x.done&&isPast(x,s.currentDT))x.done=true;});
}
function addSchedule({month,day,year=null,title,note='',source='manual'}){
    S().schedules.push({id:uid(),month:+month,day:+day,year:year?+year:null,title:title.trim(),note:note.trim(),done:false,source,createdAt:Date.now()});
    sortAndAutoCheck();saveSettingsDebounced();injectContext();
}
function removeSchedule(id){const s=S();s.schedules=s.schedules.filter(x=>x.id!==id);saveSettingsDebounced();injectContext();}
function toggleDone(id){const s=S();const x=s.schedules.find(x=>x.id===id);if(x){x.done=!x.done;saveSettingsDebounced();injectContext();}}

// ─── 캐릭터 CRUD ─────────────────────────────────────────────
function addCharacter(name){
    S().characters.push({id:uid(),name:name.trim(),fields:[{key:'',val:''}]});
    saveSettingsDebounced();injectContext();
}
function removeCharacter(id){const s=S();s.characters=s.characters.filter(x=>x.id!==id);saveSettingsDebounced();injectContext();}

// ─── 로어 CRUD ───────────────────────────────────────────────
function addLore(title,content=''){
    S().loreEntries.push({id:uid(),title:title.trim(),content:content.trim()});
    saveSettingsDebounced();injectContext();
}
function removeLore(id){const s=S();s.loreEntries=s.loreEntries.filter(x=>x.id!==id);saveSettingsDebounced();injectContext();}
function updateLore(id,title,content){
    const s=S();const e=s.loreEntries.find(x=>x.id===id);
    if(e){e.title=title;e.content=content;saveSettingsDebounced();injectContext();}
}

// ─── Context 주입 ─────────────────────────────────────────────
// Upcoming / Past Events 분리
function buildInjectText(){
    const s=S();
    const lines=[];
    const cur=s.currentDT;

    // 현재 날짜/시간
    if(cur){
        const d=fmtDate(cur),t=fmtTime(cur);
        const season=cur.season?` | Season: ${cur.season}`:'';
        lines.push(`[RP Current Date: ${d}${t?` | Time: ${t}`:''}${season}]`);
    }

    // Upcoming Schedule (미완료 & 오늘 이후)
    const upcoming=s.schedules.filter(x=>!x.done&&(!cur||!isPast(x,cur)));
    if(upcoming.length){
        lines.push('[RP Upcoming Schedule:');
        upcoming.forEach(x=>{
            const note=x.note?` (${x.note})`:'';
            lines.push(`  - ${x.month}/${x.day}: ${x.title}${note}`);
        });
        lines.push(']');
    }

    // Past Events (완료됐거나 현재날짜 지난 것)
    const past=s.schedules.filter(x=>x.done||(cur&&isPast(x,cur)));
    if(past.length){
        lines.push('[RP Past Events (already occurred — do not repeat or initiate again):');
        past.forEach(x=>{
            const note=x.note?` (${x.note})`:'';
            lines.push(`  - ${x.month}/${x.day}: ${x.title}${note} — completed`);
        });
        lines.push(']');
    }

    // 캐릭터
    s.characters.forEach(c=>{
        if(!c.name) return;
        const fieldLines=c.fields.filter(f=>f.key&&f.val).map(f=>`  ${f.key}: ${f.val}`);
        if(fieldLines.length){
            lines.push(`[Character — ${c.name}:`);
            lines.push(...fieldLines);
            lines.push(']');
        }
    });

    // 로어
    s.loreEntries.forEach(e=>{
        if(!e.title&&!e.content) return;
        lines.push(`[${e.title||'Note'}:`);
        e.content.split('\n').forEach(l=>{if(l.trim())lines.push(`  ${l.trim()}`);});
        lines.push(']');
    });

    return lines.join('\n');
}

function injectContext(){
    const s=S();
    if(!s.injectEnabled){
        setExtensionPrompt(INJECT_KEY,'',extension_prompt_types.IN_CHAT,0);
        return;
    }
    const text=buildInjectText();
    setExtensionPrompt(INJECT_KEY,text,extension_prompt_types.IN_CHAT,s.injectDepth);
}

// ─── 동기화: 마지막 메시지 파싱 ─────────────────────────────
function parseLastMessage(){
    const ctx=getContext();const chat=ctx?.chat;
    if(!chat?.length) return {dateUpdated:false,added:0};
    const lastAI=[...chat].reverse().find(m=>!m.is_user);
    if(!lastAI) return {dateUpdated:false,added:0};
    const text=lastAI.mes||'';
    const s=S();
    const dt=parseInfoBlock(text);
    let dateUpdated=false;
    if(dt){s.currentDT=dt;dateUpdated=true;}
    const found=parseSchedulesFromText(text,s.currentDT);
    let added=0;
    for(const f of found){
        if(!s.schedules.some(x=>x.month===f.month&&x.day===f.day&&x.title===f.title)){
            s.schedules.push({id:uid(),month:f.month,day:f.day,year:null,title:f.title,note:'',done:false,source:'auto',createdAt:Date.now()});
            added++;
        }
    }
    if(dateUpdated||added){sortAndAutoCheck();saveSettingsDebounced();injectContext();}
    return {dateUpdated,added};
}

// ─── Extensions 설정 탭 HTML ─────────────────────────────────
function renderExtSettings(){
    const s=S();
    const profiles=getConnectionProfiles();
    const profileOptions=profiles.map(p=>
        `<option value="${esc(p.id)}" ${p.id===s.syncProfileId?'selected':''}>${esc(p.name)}</option>`
    ).join('');

    return `<div class="rpp-ext-settings">
      <div class="rpp-es-section">
        <div class="rpp-es-title">🔗 동기화 (아웃풋 → 스케쥴러)</div>
        <div class="rpp-es-row">
          <label class="rpp-es-label">연결 프로필</label>
          <select id="rpp-es-profile" class="rpp-es-select">
            <option value="">메인 API 따라가기</option>
            ${profileOptions}
          </select>
        </div>
        <div class="rpp-es-row">
          <label class="rpp-es-label">동기화 방식</label>
          <div class="rpp-es-radio-group">
            <label class="rpp-es-radio">
              <input type="radio" name="rpp-sync-mode" value="auto" ${s.autoSync?'checked':''}>
              <span>자동 (메시지마다)</span>
            </label>
            <label class="rpp-es-radio">
              <input type="radio" name="rpp-sync-mode" value="manual" ${!s.autoSync?'checked':''}>
              <span>수동 (⚡ 버튼)</span>
            </label>
          </div>
        </div>
      </div>

      <div class="rpp-es-section">
        <div class="rpp-es-title">📤 롤플 반영 (스케쥴러 → Context)</div>
        <div class="rpp-es-row">
          <label class="rpp-es-label">주입 활성화</label>
          <label class="rpp-es-toggle-wrap">
            <input type="checkbox" id="rpp-es-inject" ${s.injectEnabled?'checked':''}>
            <span class="rpp-es-toggle"></span>
          </label>
        </div>
        <div class="rpp-es-row">
          <label class="rpp-es-label">삽입 위치 (depth)</label>
          <input type="number" id="rpp-es-depth" class="rpp-es-num" value="${s.injectDepth}" min="0" max="10">
          <span class="rpp-es-hint">0=시스템 끝, 2=마지막 메시지 앞</span>
        </div>
      </div>

      <div class="rpp-es-section rpp-es-preview">
        <div class="rpp-es-title">👁 현재 주입 내용 미리보기</div>
        <pre id="rpp-es-preview-text" class="rpp-es-pre">${esc(buildInjectText()||'(비어있음)')}</pre>
      </div>
    </div>`;
}

function bindExtSettings(){
    // 연결 프로필 선택
    document.getElementById('rpp-es-profile')?.addEventListener('change',e=>{
        S().syncProfileId=e.target.value||null;
        saveSettingsDebounced();
    });
    // 자동/수동 동기화
    document.querySelectorAll('input[name="rpp-sync-mode"]').forEach(r=>{
        r.addEventListener('change',()=>{
            S().autoSync=r.value==='auto';
            saveSettingsDebounced();
            updateSyncBadge();
        });
    });
    // 주입 토글
    document.getElementById('rpp-es-inject')?.addEventListener('change',e=>{
        S().injectEnabled=e.target.checked;
        saveSettingsDebounced();injectContext();
        updateInjectBadge();
        // 미리보기 갱신
        const pre=document.getElementById('rpp-es-preview-text');
        if(pre) pre.textContent=buildInjectText()||'(비어있음)';
    });
    // depth
    document.getElementById('rpp-es-depth')?.addEventListener('change',e=>{
        S().injectDepth=parseInt(e.target.value)||2;
        saveSettingsDebounced();injectContext();
    });
}

// ─── 패널 탭 배지 상태 ───────────────────────────────────────
function updateSyncBadge(){
    // 번개버튼: 수동모드일 때 강조
    const btn=document.getElementById('rpp-sync-btn');
    if(!btn) return;
    const s=S();
    btn.title=s.autoSync?'자동 동기화 켜짐 (클릭: 지금 동기화)':'수동 동기화 (클릭: 지금 동기화)';
    btn.classList.toggle('manual-mode',!s.autoSync);
}
function updateInjectBadge(){
    const btn=document.getElementById('rpp-inject-status');
    if(!btn) return;
    btn.classList.toggle('off',!S().injectEnabled);
    btn.title=S().injectEnabled?'롤플 반영 켜짐':'롤플 반영 꺼짐';
}

// ══════════════════════════════════════════════════════════════
// UI
// ══════════════════════════════════════════════════════════════
let panelOpen=false;
let activeTab='calendar';
let calYear=null,calMonth=null;
let scheduleFilterDay=null;

function getPanelHTML(){
    return `
<div id="rpp-panel">
  <div id="rpp-tabs">
    <button class="rpp-tab" data-tab="calendar" title="캘린더">📅</button>
    <button class="rpp-tab" data-tab="schedule" title="스케쥴">🗓</button>
    <button class="rpp-tab" data-tab="character" title="캐릭터">👤</button>
    <button class="rpp-tab" data-tab="lore" title="로어">🏠</button>
    <button class="rpp-tab" data-tab="settings" title="설정">⚙️</button>
    <div class="rpp-tab-spacer"></div>
    <button id="rpp-inject-status" class="rpp-tab rpp-status-btn" title="롤플 반영 켜짐">📤</button>
    <button id="rpp-sync-btn" class="rpp-tab rpp-sync-btn" title="지금 동기화">⚡</button>
    <button id="rpp-close" class="rpp-tab rpp-close-tab">✕</button>
  </div>
  <div id="rpp-content"></div>
  <div id="rpp-toast"></div>
</div>`;
}

function switchTab(tab,opts={}){
    activeTab=tab;
    document.querySelectorAll('.rpp-tab[data-tab]').forEach(b=>{
        b.classList.toggle('active',b.dataset.tab===tab);
    });
    const c=document.getElementById('rpp-content');
    if(!c) return;
    if(opts.day) scheduleFilterDay=opts.day;
    switch(tab){
        case 'calendar':  c.innerHTML=renderCalendar();  bindCalendarEvents();  break;
        case 'schedule':  c.innerHTML=renderSchedule();  bindScheduleEvents();  break;
        case 'character': c.innerHTML=renderCharacter(); bindCharacterEvents(); break;
        case 'lore':      c.innerHTML=renderLore();      bindLoreEvents();      break;
        case 'settings':  c.innerHTML=renderExtSettings();bindExtSettings();    break;
    }
}

// ══════════════════════════════════════════════════════════════
// TAB 1: CALENDAR
// ══════════════════════════════════════════════════════════════
function renderCalendar(){
    const s=S();const cur=s.currentDT;
    if(!calYear||!calMonth){
        calYear=cur?.year??new Date().getFullYear();
        calMonth=cur?.month??new Date().getMonth()+1;
    }
    const year=calYear,month=calMonth;
    const dtStr=cur?`${fmtDate(cur)}${fmtTime(cur)?'  '+fmtTime(cur):''}${cur.season?'  '+cur.season:''}`:'날짜 미설정';
    const firstDay=new Date(year,month-1,1).getDay();
    const daysInMonth=new Date(year,month,0).getDate();
    const prevDays=new Date(year,month-1,0).getDate();

    const schedMap={};
    s.schedules.forEach(sc=>{
        if(sc.year&&sc.year!==year) return;
        if(sc.month!==month) return;
        if(!schedMap[sc.day]) schedMap[sc.day]=[];
        schedMap[sc.day].push(sc);
    });

    const dns=['일','월','화','수','목','금','토'];
    const dhdr=dns.map((d,i)=>`<div class="cal-dh${i===0?' sun':i===6?' sat':''}">${d}</div>`).join('');

    let cells='';
    for(let i=0;i<firstDay;i++){
        cells+=`<div class="cal-cell cal-other"><span class="cal-num">${prevDays-firstDay+1+i}</span></div>`;
    }
    for(let d=1;d<=daysInMonth;d++){
        const dow=(firstDay+d-1)%7;
        const isCur=cur&&cur.month===month&&cur.day===d&&(cur.year??year)===year;
        const scs=schedMap[d]||[];
        let cls='cal-cell';
        if(dow===0)cls+=' sun';if(dow===6)cls+=' sat';
        if(isCur)cls+=' cal-today';
        const pills=scs.slice(0,2).map(sc=>`<div class="cal-pill ${sc.done?'pill-done':'pill-active'}">${esc(sc.title)}</div>`).join('');
        cells+=`<div class="${cls}" data-day="${d}"><span class="cal-num">${d}</span>${pills}</div>`;
    }
    const rem=(7-((firstDay+daysInMonth)%7))%7;
    for(let i=1;i<=rem;i++) cells+=`<div class="cal-cell cal-other"><span class="cal-num">${i}</span></div>`;

    return `<div class="rpp-cal-wrap">
      <div class="cal-dt-bar">
        <div class="cal-dt-main">${esc(dtStr)}</div>
        <button class="rpp-btn rpp-btn-xs" id="cal-dt-edit-btn">수정</button>
      </div>
      <div id="cal-dt-form" class="cal-dt-form" style="display:none">
        <div class="cal-df-row">
          <input id="cdf-y" type="number" class="rpp-inp" placeholder="연도" style="width:62px">
          <input id="cdf-m" type="number" class="rpp-inp" placeholder="월" min="1" max="12" style="width:42px">
          <input id="cdf-d" type="number" class="rpp-inp" placeholder="일" min="1" max="31" style="width:42px">
        </div>
        <div class="cal-df-row">
          <input id="cdf-h" type="number" class="rpp-inp" placeholder="시" min="0" max="23" style="width:42px">
          <span class="rpp-sep">:</span>
          <input id="cdf-mi" type="number" class="rpp-inp" placeholder="분" min="0" max="59" style="width:42px">
          <input id="cdf-s" type="text" class="rpp-inp" placeholder="계절" style="width:56px">
        </div>
        <div class="cal-df-row">
          <button class="rpp-btn rpp-btn-primary rpp-btn-xs" id="cdf-save">저장</button>
          <button class="rpp-btn rpp-btn-xs" id="cdf-cancel">취소</button>
        </div>
      </div>
      <div class="cal-nav">
        <button class="rpp-btn rpp-btn-xs" id="cal-prev">‹</button>
        <span class="cal-month-label">${year}년 ${month}월</span>
        <button class="rpp-btn rpp-btn-xs" id="cal-next">›</button>
      </div>
      <div class="cal-grid">
        <div class="cal-header">${dhdr}</div>
        <div class="cal-body">${cells}</div>
      </div>
      <div class="cal-legend">
        <span class="cal-dot dot-active"></span><span>예정</span>
        <span class="cal-dot dot-done" style="margin-left:8px"></span><span>완료/경과</span>
      </div>
    </div>`;
}

function bindCalendarEvents(){
    document.getElementById('cal-prev')?.addEventListener('click',()=>{calMonth--;if(calMonth<1){calMonth=12;calYear--;}switchTab('calendar');});
    document.getElementById('cal-next')?.addEventListener('click',()=>{calMonth++;if(calMonth>12){calMonth=1;calYear++;}switchTab('calendar');});
    document.querySelectorAll('.cal-cell[data-day]').forEach(cell=>{
        cell.addEventListener('click',()=>{
            scheduleFilterDay={month:calMonth,day:+cell.dataset.day};
            switchTab('schedule');
        });
    });
    document.getElementById('cal-dt-edit-btn')?.addEventListener('click',()=>{
        const f=document.getElementById('cal-dt-form');
        const open=f.style.display==='none';
        f.style.display=open?'flex':'none';
        if(open){const dt=S().currentDT;if(dt){document.getElementById('cdf-y').value=dt.year??'';document.getElementById('cdf-m').value=dt.month??'';document.getElementById('cdf-d').value=dt.day??'';document.getElementById('cdf-h').value=dt.hour??'';document.getElementById('cdf-mi').value=dt.minute??'';document.getElementById('cdf-s').value=dt.season??'';}}
    });
    document.getElementById('cdf-cancel')?.addEventListener('click',()=>{document.getElementById('cal-dt-form').style.display='none';});
    document.getElementById('cdf-save')?.addEventListener('click',()=>{
        const y=parseInt(document.getElementById('cdf-y').value)||null;
        const m=parseInt(document.getElementById('cdf-m').value);
        const d=parseInt(document.getElementById('cdf-d').value);
        const h=document.getElementById('cdf-h').value!==''?parseInt(document.getElementById('cdf-h').value):null;
        const mi=document.getElementById('cdf-mi').value!==''?parseInt(document.getElementById('cdf-mi').value):null;
        const season=document.getElementById('cdf-s').value.trim()||null;
        if(!m||!d){toast('월/일은 필수입니다',true);return;}
        S().currentDT={year:y,month:m,day:d,hour:h,minute:mi,season};
        calYear=y??calYear;calMonth=m;
        sortAndAutoCheck();saveSettingsDebounced();injectContext();
        document.getElementById('cal-dt-form').style.display='none';
        switchTab('calendar');toast('날짜 설정 완료');
    });
}

// ══════════════════════════════════════════════════════════════
// TAB 2: SCHEDULE
// ══════════════════════════════════════════════════════════════
function renderSchedule(){
    const s=S();const cur=s.currentDT;
    const filter=scheduleFilterDay;
    const filterLabel=filter?`${filter.month}월 ${filter.day}일`:'전체';
    const list=filter?s.schedules.filter(x=>x.month===filter.month&&x.day===filter.day):s.schedules;

    const todayItems=list.filter(x=>!x.done&&isToday(x,cur));
    const upcomingItems=list.filter(x=>!x.done&&!isToday(x,cur)&&!isPast(x,cur));
    const pastItems=list.filter(x=>x.done||isPast(x,cur));

    const itemHTML=x=>{
        const past=isPast(x,cur),today=isToday(x,cur);
        let cls='',badge='';
        if(x.done){cls='sch-done';badge='<span class="sch-badge done">완료</span>';}
        else if(today){cls='sch-today';badge='<span class="sch-badge today">오늘</span>';}
        else if(past){cls='sch-past';badge='<span class="sch-badge past">경과</span>';}
        const src=x.source==='manual'?'✏':'◈';
        return `<div class="sch-item ${cls}" data-id="${x.id}">
          <label class="sch-chk-wrap"><input type="checkbox" class="sch-cb" data-id="${x.id}" ${x.done?'checked':''}><span class="sch-box"></span></label>
          <div class="sch-body">
            <div class="sch-meta"><span class="sch-date">${x.month}/${x.day}</span>${badge}<span class="sch-src">${src}</span></div>
            <div class="sch-title">${esc(x.title)}</div>
            ${x.note?`<div class="sch-note">${esc(x.note)}</div>`:''}
          </div>
          <button class="sch-edit-btn" data-id="${x.id}" title="수정">✎</button>
          <button class="sch-del-btn" data-id="${x.id}" title="삭제">✕</button>
        </div>`;
    };

    let listHTML='';
    if(todayItems.length){listHTML+='<div class="sch-grp-label">📅 오늘</div>';listHTML+=todayItems.map(itemHTML).join('');}
    if(upcomingItems.length){listHTML+='<div class="sch-grp-label">⏳ 예정</div>';listHTML+=upcomingItems.map(itemHTML).join('');}
    if(pastItems.length){listHTML+=`<div class="sch-grp-label dim">✔ 지난 일정 (${pastItems.length})</div><div class="sch-past-grp">${pastItems.map(itemHTML).join('')}</div>`;}
    if(!list.length) listHTML='<div class="rpp-empty">등록된 일정이 없습니다</div>';

    return `<div class="rpp-sch-wrap">
      <div class="sch-filter-bar">
        <span class="sch-filter-label">${esc(filterLabel)}</span>
        ${filter?'<button class="rpp-btn rpp-btn-xs" id="sch-filter-clear">전체보기</button>':''}
        <div class="rpp-spacer"></div>
        <button class="rpp-btn rpp-btn-xs" id="sch-clear-done">완료 삭제</button>
      </div>
      <div class="sch-add-wrap">
        <div class="sch-add-row">
          <input id="sa-m" type="number" class="rpp-inp" placeholder="월" min="1" max="12" style="width:44px">
          <span class="rpp-sep">월</span>
          <input id="sa-d" type="number" class="rpp-inp" placeholder="일" min="1" max="31" style="width:44px">
          <span class="rpp-sep">일</span>
          <input id="sa-t" type="text" class="rpp-inp" placeholder="일정 제목" style="flex:1">
        </div>
        <div class="sch-add-row">
          <input id="sa-n" type="text" class="rpp-inp" placeholder="메모 (선택)" style="flex:1">
          <button class="rpp-btn rpp-btn-primary rpp-btn-xs" id="sch-add-btn">추가</button>
        </div>
      </div>
      <div id="sch-list" class="sch-list">${listHTML}</div>
    </div>`;
}

function bindScheduleEvents(){
    document.getElementById('sch-filter-clear')?.addEventListener('click',()=>{scheduleFilterDay=null;switchTab('schedule');});
    document.getElementById('sch-clear-done')?.addEventListener('click',()=>{
        const s=S();const b=s.schedules.length;
        s.schedules=s.schedules.filter(x=>!x.done);
        saveSettingsDebounced();injectContext();
        switchTab('schedule');
        toast(`${b-s.schedules.length}개 삭제됨`);
    });
    document.getElementById('sch-add-btn')?.addEventListener('click',doAddSchedule);
    document.getElementById('sa-t')?.addEventListener('keydown',e=>{if(e.key==='Enter')doAddSchedule();});
    bindSchListEvents();
}

function doAddSchedule(){
    const m=document.getElementById('sa-m')?.value;
    const d=document.getElementById('sa-d')?.value;
    const t=document.getElementById('sa-t')?.value.trim();
    const n=document.getElementById('sa-n')?.value.trim()||'';
    if(!m||!d||!t){toast('월, 일, 제목을 입력하세요',true);return;}
    addSchedule({month:m,day:d,title:t,note:n,source:'manual'});
    ['sa-m','sa-d','sa-t','sa-n'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    renderSchList();toast('일정 추가됨');
}

function renderSchList(){
    const el=document.getElementById('sch-list');if(!el)return;
    const s=S();const cur=s.currentDT;
    const filter=scheduleFilterDay;
    const list=filter?s.schedules.filter(x=>x.month===filter.month&&x.day===filter.day):s.schedules;

    const todayI=list.filter(x=>!x.done&&isToday(x,cur));
    const upI=list.filter(x=>!x.done&&!isToday(x,cur)&&!isPast(x,cur));
    const pastI=list.filter(x=>x.done||isPast(x,cur));

    const iH=x=>{
        const past=isPast(x,cur),today=isToday(x,cur);
        let cls='',badge='';
        if(x.done){cls='sch-done';badge='<span class="sch-badge done">완료</span>';}
        else if(today){cls='sch-today';badge='<span class="sch-badge today">오늘</span>';}
        else if(past){cls='sch-past';badge='<span class="sch-badge past">경과</span>';}
        const src=x.source==='manual'?'✏':'◈';
        return `<div class="sch-item ${cls}" data-id="${x.id}">
          <label class="sch-chk-wrap"><input type="checkbox" class="sch-cb" data-id="${x.id}" ${x.done?'checked':''}><span class="sch-box"></span></label>
          <div class="sch-body">
            <div class="sch-meta"><span class="sch-date">${x.month}/${x.day}</span>${badge}<span class="sch-src">${src}</span></div>
            <div class="sch-title">${esc(x.title)}</div>
            ${x.note?`<div class="sch-note">${esc(x.note)}</div>`:''}
          </div>
          <button class="sch-edit-btn" data-id="${x.id}">✎</button>
          <button class="sch-del-btn" data-id="${x.id}">✕</button>
        </div>`;
    };
    let h='';
    if(todayI.length){h+='<div class="sch-grp-label">📅 오늘</div>';h+=todayI.map(iH).join('');}
    if(upI.length){h+='<div class="sch-grp-label">⏳ 예정</div>';h+=upI.map(iH).join('');}
    if(pastI.length){h+=`<div class="sch-grp-label dim">✔ 지난 (${pastI.length})</div><div class="sch-past-grp">${pastI.map(iH).join('')}</div>`;}
    if(!list.length)h='<div class="rpp-empty">등록된 일정이 없습니다</div>';
    el.innerHTML=h;
    bindSchListEvents();
}

function bindSchListEvents(){
    document.querySelectorAll('.sch-cb').forEach(cb=>{
        cb.addEventListener('change',()=>{toggleDone(cb.dataset.id);renderSchList();});
    });
    document.querySelectorAll('.sch-del-btn').forEach(b=>{
        b.addEventListener('click',()=>{removeSchedule(b.dataset.id);renderSchList();});
    });
    document.querySelectorAll('.sch-edit-btn').forEach(b=>{
        b.addEventListener('click',()=>openSchEdit(b.dataset.id));
    });
}

function openSchEdit(id){
    document.querySelectorAll('.sch-edit-form').forEach(e=>e.remove());
    const x=S().schedules.find(x=>x.id===id);if(!x)return;
    const form=document.createElement('div');
    form.className='sch-edit-form';form.id='sef-'+id;
    form.innerHTML=`
      <div class="sef-row">
        <input id="sem${id}" type="number" class="rpp-inp" value="${x.month}" style="width:42px" min="1" max="12">
        <span class="rpp-sep">월</span>
        <input id="sed${id}" type="number" class="rpp-inp" value="${x.day}" style="width:42px" min="1" max="31">
        <span class="rpp-sep">일</span>
      </div>
      <div class="sef-row"><input id="set${id}" type="text" class="rpp-inp" value="${esc(x.title)}" style="flex:1"></div>
      <div class="sef-row"><input id="sen${id}" type="text" class="rpp-inp" value="${esc(x.note)}" placeholder="메모" style="flex:1"></div>
      <div class="sef-btns">
        <button class="rpp-btn rpp-btn-primary rpp-btn-xs" id="sef-save-${id}">저장</button>
        <button class="rpp-btn rpp-btn-xs" id="sef-cancel-${id}">취소</button>
      </div>`;
    document.querySelector(`.sch-item[data-id="${id}"]`)?.insertAdjacentElement('afterend',form);
    document.getElementById(`sef-cancel-${id}`)?.addEventListener('click',()=>form.remove());
    document.getElementById(`sef-save-${id}`)?.addEventListener('click',()=>{
        const m=parseInt(document.getElementById(`sem${id}`).value);
        const d=parseInt(document.getElementById(`sed${id}`).value);
        const t=document.getElementById(`set${id}`).value.trim();
        const n=document.getElementById(`sen${id}`).value.trim();
        if(!m||!d||!t){toast('월, 일, 제목은 필수입니다',true);return;}
        const s=S();const item=s.schedules.find(x=>x.id===id);
        if(item){item.month=m;item.day=d;item.title=t;item.note=n;}
        sortAndAutoCheck();saveSettingsDebounced();injectContext();
        form.remove();renderSchList();toast('수정 완료');
    });
}

// ══════════════════════════════════════════════════════════════
// TAB 3: CHARACTER
// ══════════════════════════════════════════════════════════════
function renderCharacter(){
    const s=S();
    let html='';
    s.characters.forEach(c=>{
        html+=`<div class="chr-card" data-id="${c.id}">
          <div class="chr-card-header">
            <input type="text" class="rpp-inp chr-name-inp" data-id="${c.id}" value="${esc(c.name)}" placeholder="캐릭터 이름">
            <button class="chr-del-btn rpp-btn rpp-btn-xs" data-id="${c.id}">삭제</button>
          </div>
          <div class="chr-fields">
            ${c.fields.map((f,i)=>`<div class="chr-field-row">
              <input type="text" class="rpp-inp chr-fkey" data-cid="${c.id}" data-idx="${i}" value="${esc(f.key)}" placeholder="항목명" style="width:90px">
              <span class="rpp-sep">:</span>
              <input type="text" class="rpp-inp chr-fval" data-cid="${c.id}" data-idx="${i}" value="${esc(f.val)}" placeholder="내용" style="flex:1">
              <button class="chr-field-del rpp-btn rpp-btn-xs" data-cid="${c.id}" data-idx="${i}">−</button>
            </div>`).join('')}
          </div>
          <div class="chr-card-footer">
            <button class="rpp-btn rpp-btn-xs chr-field-add" data-id="${c.id}">+ 항목 추가</button>
            <button class="rpp-btn rpp-btn-primary rpp-btn-xs chr-save-btn" data-id="${c.id}">저장</button>
          </div>
        </div>`;
    });
    if(!s.characters.length) html='<div class="rpp-empty">캐릭터가 없습니다</div>';
    return `<div class="rpp-chr-wrap">
      <div class="chr-top-bar">
        <input id="chr-new-name" type="text" class="rpp-inp" placeholder="새 캐릭터 이름" style="flex:1">
        <button class="rpp-btn rpp-btn-primary rpp-btn-xs" id="chr-add-btn">추가</button>
      </div>
      <div id="chr-list">${html}</div>
    </div>`;
}

function bindCharacterEvents(){
    document.getElementById('chr-add-btn')?.addEventListener('click',()=>{
        const name=document.getElementById('chr-new-name').value.trim();
        if(!name){toast('이름을 입력하세요',true);return;}
        addCharacter(name);
        document.getElementById('chr-new-name').value='';
        switchTab('character');toast('캐릭터 추가됨');
    });
    document.getElementById('chr-new-name')?.addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('chr-add-btn')?.click();});
    document.getElementById('chr-list')?.addEventListener('click',e=>{
        const delCard=e.target.closest('.chr-del-btn');
        if(delCard){removeCharacter(delCard.dataset.id);switchTab('character');toast('삭제됨');return;}
        const addField=e.target.closest('.chr-field-add');
        if(addField){const s=S();const c=s.characters.find(x=>x.id===addField.dataset.id);if(c){c.fields.push({key:'',val:''});saveSettingsDebounced();switchTab('character');}return;}
        const delField=e.target.closest('.chr-field-del');
        if(delField){const s=S();const c=s.characters.find(x=>x.id===delField.dataset.cid);if(c){c.fields.splice(+delField.dataset.idx,1);saveSettingsDebounced();injectContext();switchTab('character');}return;}
        const save=e.target.closest('.chr-save-btn');
        if(save){
            const id=save.dataset.id;const s=S();const c=s.characters.find(x=>x.id===id);if(!c)return;
            const nameEl=document.querySelector(`.chr-name-inp[data-id="${id}"]`);
            if(nameEl)c.name=nameEl.value.trim();
            const keys=document.querySelectorAll(`.chr-fkey[data-cid="${id}"]`);
            const vals=document.querySelectorAll(`.chr-fval[data-cid="${id}"]`);
            c.fields=[];
            keys.forEach((k,i)=>{c.fields.push({key:k.value.trim(),val:vals[i].value.trim()});});
            c.fields=c.fields.filter(f=>f.key||f.val);
            saveSettingsDebounced();injectContext();toast('저장됨');
        }
    });
}

// ══════════════════════════════════════════════════════════════
// TAB 4: LORE
// ══════════════════════════════════════════════════════════════
function renderLore(){
    const s=S();
    let html='';
    s.loreEntries.forEach(e=>{
        html+=`<div class="lore-card" data-id="${e.id}">
          <div class="lore-card-header">
            <input type="text" class="rpp-inp lore-title-inp" data-id="${e.id}" value="${esc(e.title)}" placeholder="제목" style="flex:1">
            <button class="lore-del-btn rpp-btn rpp-btn-xs" data-id="${e.id}">삭제</button>
          </div>
          <textarea class="rpp-textarea lore-content" data-id="${e.id}" placeholder="내용 입력...">${esc(e.content)}</textarea>
          <div class="lore-card-footer">
            <button class="rpp-btn rpp-btn-primary rpp-btn-xs lore-save-btn" data-id="${e.id}">저장</button>
          </div>
        </div>`;
    });
    if(!s.loreEntries.length) html='<div class="rpp-empty">로어 항목이 없습니다</div>';
    return `<div class="rpp-lore-wrap">
      <div class="lore-top-bar">
        <input id="lore-new-title" type="text" class="rpp-inp" placeholder="제목" style="flex:1">
        <button class="rpp-btn rpp-btn-primary rpp-btn-xs" id="lore-add-btn">추가</button>
      </div>
      <div id="lore-list">${html}</div>
    </div>`;
}

function bindLoreEvents(){
    document.getElementById('lore-add-btn')?.addEventListener('click',()=>{
        const title=document.getElementById('lore-new-title').value.trim();
        addLore(title,'');
        document.getElementById('lore-new-title').value='';
        switchTab('lore');toast('항목 추가됨');
    });
    document.getElementById('lore-new-title')?.addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('lore-add-btn')?.click();});
    document.getElementById('lore-list')?.addEventListener('click',e=>{
        const del=e.target.closest('.lore-del-btn');
        if(del){removeLore(del.dataset.id);switchTab('lore');toast('삭제됨');return;}
        const save=e.target.closest('.lore-save-btn');
        if(save){
            const id=save.dataset.id;
            const title=document.querySelector(`.lore-title-inp[data-id="${id}"]`)?.value.trim()||'';
            const content=document.querySelector(`.lore-content[data-id="${id}"]`)?.value.trim()||'';
            updateLore(id,title,content);toast('저장됨');
        }
    });
}

// ─── 토스트 ──────────────────────────────────────────────────
let _toastTimer;
function toast(msg,err=false){
    const el=document.getElementById('rpp-toast');if(!el)return;
    el.textContent=msg;el.className=err?'rpp-toast-err show':'show';
    clearTimeout(_toastTimer);_toastTimer=setTimeout(()=>el.className='',2600);
}

// ─── 패널 열기/닫기 ──────────────────────────────────────────
let _outsideH=null;

function openPanel(){
    if(document.getElementById('rpp-panel'))return;
    const wrap=document.createElement('div');
    wrap.id='rpp-wrapper';
    wrap.innerHTML=getPanelHTML();
    document.body.appendChild(wrap);

    document.querySelectorAll('.rpp-tab[data-tab]').forEach(b=>{
        b.addEventListener('click',()=>switchTab(b.dataset.tab));
    });
    document.getElementById('rpp-close')?.addEventListener('click',closePanel);

    // ⚡ 수동 동기화 버튼
    document.getElementById('rpp-sync-btn')?.addEventListener('click',()=>{
        const {dateUpdated,added}=parseLastMessage();
        if(activeTab==='calendar') switchTab('calendar');
        else if(activeTab==='schedule') renderSchList();
        if(dateUpdated&&added) toast(`날짜 갱신 + ${added}개 감지`);
        else if(dateUpdated) toast('날짜/시간 갱신됨');
        else if(added) toast(`${added}개 일정 감지됨`);
        else toast('감지된 정보 없음');
    });

    // 📤 주입 토글
    document.getElementById('rpp-inject-status')?.addEventListener('click',()=>{
        const s=S();s.injectEnabled=!s.injectEnabled;
        saveSettingsDebounced();injectContext();
        updateInjectBadge();
        toast(s.injectEnabled?'롤플 반영 켜짐':'롤플 반영 꺼짐');
    });

    updateSyncBadge();
    updateInjectBadge();
    panelOpen=true;
    switchTab('calendar');

    setTimeout(()=>{
        _outsideH=e=>{
            const panel=document.getElementById('rpp-panel');
            const btn=document.getElementById('rpp-toolbar-btn');
            if(panel&&!panel.contains(e.target)&&btn&&!btn.contains(e.target))closePanel();
        };
        document.addEventListener('click',_outsideH);
    },80);
}

function closePanel(){
    document.getElementById('rpp-wrapper')?.remove();
    if(_outsideH){document.removeEventListener('click',_outsideH);_outsideH=null;}
    panelOpen=false;
}

// ─── 메시지 수신 훅 ──────────────────────────────────────────
function onMessageReceived(){
    if(!S().autoSync) return; // 수동 모드면 스킵
    const {dateUpdated,added}=parseLastMessage();
    if(panelOpen&&(dateUpdated||added)){
        if(activeTab==='calendar') switchTab('calendar');
        else if(activeTab==='schedule') renderSchList();
        if(added) toast(`${added}개 일정 감지됨`);
        if(dateUpdated) toast(added?`날짜 갱신 + ${added}개`:'날짜/시간 갱신됨');
    }
    if(added){
        const badge=document.getElementById('rpp-badge');
        if(badge) badge.style.display='flex';
    }
}

// ─── Extensions 설정 탭 등록 ─────────────────────────────────
function registerSettingsUI(){
    // ST Extensions 패널에 설정 섹션 삽입
    const settingsHtml=`
    <div id="rpp-ext-settings-block" class="rpp-ext-block">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>RP Planner</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="rpp-ext-inner">
            <div class="rpp-ext-row">
              <label>연결 프로필 (동기화용)</label>
              <select id="rpp-settings-profile" class="text_pole">
                <option value="">메인 API 따라가기</option>
              </select>
            </div>
            <div class="rpp-ext-row">
              <label>동기화 방식</label>
              <select id="rpp-settings-sync" class="text_pole">
                <option value="auto">자동 (메시지마다)</option>
                <option value="manual">수동 (⚡ 버튼)</option>
              </select>
            </div>
            <div class="rpp-ext-row">
              <label>롤플 반영 (주입)</label>
              <input type="checkbox" id="rpp-settings-inject">
            </div>
            <div class="rpp-ext-row">
              <label>삽입 depth</label>
              <input type="number" id="rpp-settings-depth" class="text_pole" style="width:60px" min="0" max="10">
            </div>
          </div>
        </div>
      </div>
    </div>`;

    const container=document.getElementById('extensions_settings2')??document.getElementById('extensions_settings');
    if(container){
        container.insertAdjacentHTML('beforeend',settingsHtml);
        populateExtSettingsUI();
        bindExtSettingsGlobal();
    }
}

function populateExtSettingsUI(){
    const s=S();
    const profiles=getConnectionProfiles();
    const sel=document.getElementById('rpp-settings-profile');
    if(sel){
        sel.innerHTML='<option value="">메인 API 따라가기</option>';
        profiles.forEach(p=>{
            const opt=document.createElement('option');
            opt.value=p.id;opt.textContent=p.name;
            if(p.id===s.syncProfileId)opt.selected=true;
            sel.appendChild(opt);
        });
    }
    const syncSel=document.getElementById('rpp-settings-sync');
    if(syncSel) syncSel.value=s.autoSync?'auto':'manual';
    const injectCb=document.getElementById('rpp-settings-inject');
    if(injectCb) injectCb.checked=s.injectEnabled;
    const depthInp=document.getElementById('rpp-settings-depth');
    if(depthInp) depthInp.value=s.injectDepth;
}

function bindExtSettingsGlobal(){
    document.getElementById('rpp-settings-profile')?.addEventListener('change',e=>{
        S().syncProfileId=e.target.value||null;saveSettingsDebounced();
    });
    document.getElementById('rpp-settings-sync')?.addEventListener('change',e=>{
        S().autoSync=e.target.value==='auto';saveSettingsDebounced();updateSyncBadge();
    });
    document.getElementById('rpp-settings-inject')?.addEventListener('change',e=>{
        S().injectEnabled=e.target.checked;saveSettingsDebounced();injectContext();updateInjectBadge();
    });
    document.getElementById('rpp-settings-depth')?.addEventListener('change',e=>{
        S().injectDepth=parseInt(e.target.value)||2;saveSettingsDebounced();injectContext();
    });
}

// ─── 초기화 ──────────────────────────────────────────────────
jQuery(async()=>{
    if(!extension_settings[EXT]) extension_settings[EXT]=structuredClone(DEFAULTS);

    const btnHTML=`<div id="rpp-toolbar-btn" class="rpp-toolbar-btn" title="RP Planner">
      <span>📆</span>
      <span id="rpp-badge" style="display:none" class="rpp-badge-dot"></span>
    </div>`;
    const toolbar=document.getElementById('extensionsMenu')??document.getElementById('top-bar');
    toolbar?.insertAdjacentHTML('beforeend',btnHTML);

    document.getElementById('rpp-toolbar-btn')?.addEventListener('click',e=>{
        e.stopPropagation();
        const badge=document.getElementById('rpp-badge');
        if(badge)badge.style.display='none';
        panelOpen?closePanel():openPanel();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED,onMessageReceived);

    registerSettingsUI();
    injectContext();
    console.log(LOG,'v3 loaded');
});

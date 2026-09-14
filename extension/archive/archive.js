"use strict";
const $ = id => document.getElementById(id);
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
let stopping=false, running=false, scannerId=null, studyTabId=null;
let report={events:[],issues:[]}, db;
const database=new Promise((resolve,reject)=>{
  const request=indexedDB.open('relay-rook-books',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('records',{keyPath:'key'});
  request.onsuccess=()=>{db=request.result;resolve();}; request.onerror=()=>reject(request.error);
});
async function record(key,value) {
  await database;
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('records',value===undefined?'readonly':'readwrite');
    const store=tx.objectStore('records'), request=value===undefined?store.get(key):store.put({key,value});
    tx.oncomplete=()=>resolve(value===undefined?request.result?.value:value);
    tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error || Error('Book storage transaction aborted.'));
  });
}
async function allCourses() {
  await database;
  return new Promise((resolve,reject)=>{
    const request=db.transaction('records').objectStore('records').getAll();
    request.onsuccess=()=>resolve(request.result.filter(r=>r.key.startsWith('course:')).map(r=>r.value));
    request.onerror=()=>reject(request.error);
  });
}
function log(message,level='info') {
  report.events.push({at:new Date().toISOString(),level,message});
  if(report.events.length>500)report.events.shift();
  $('activity').textContent=report.events.map(e=>`[${e.at}] ${e.level.toUpperCase()} ${e.message}`).join('\n');
  $('activity').scrollTop=$('activity').scrollHeight;
  chrome.storage.local.set({bookReport:report}).catch(e=>{$('status').textContent=`Cannot persist the log: ${e.message}`;});
}
function issue(message) {report.issues.push({at:new Date().toISOString(),message});log(message,'error');}
function stage(message){$('status').textContent=message;log(message);}
async function render() {
  $('books').replaceChildren(...(await allCourses()).map(course=>{
    const tr=document.createElement('tr');
    for(const value of [course.title,`${course.saved || 0} / ${course.total ?? '?'}${course.complete?' · Complete':' · Incomplete'}`,'']){
      const td=document.createElement('td');td.textContent=value;tr.append(td);
    }
    for(const [title,action] of [['Save files',()=>saveBook(course)],['Create private studies',()=>importBook(course)]]){
      const button=document.createElement('button');button.textContent=title;button.disabled=running || !course.complete;
      button.onclick=async()=>{try{if(title==='Create private studies')await access();await exclusive(action);}catch(e){issue(e.message);}};tr.lastChild.append(button);
    }
    for(const study of course.studies || []){
      const a=document.createElement('a');a.href=study.url;a.target='_blank';a.rel='noopener';a.textContent=`Volume ${study.part}${study.verified?' ✓':' · needs verification'}`;
      tr.lastChild.append(document.createElement('br'),a);
    }
    return tr;
  }));
}
async function waitTab(id,test) {
  for(let n=0;n<120;n++){
    const tab=await chrome.tabs.get(id);
    if(tab.status==='complete' && test(new URL(tab.url || 'about:blank')))return tab;
    await delay(500);
  }
  throw Error('Page did not finish loading within 60 seconds.');
}
async function scanPage(url,mode,lesson) {
  if(stopping)throw Error('Scan stopped. Completed lessons are retained.');
  const target=new URL(url);
  if(target.origin!=='https://www.chessable.com')throw Error('Unexpected Chessable origin.');
  target.hash=`relay-rook-archive=${crypto.randomUUID()}`;
  if(scannerId===null)scannerId=(await chrome.tabs.create({url:target.href,active:false})).id;
  else await chrome.tabs.update(scannerId,{url:target.href});
  await waitTab(scannerId,u=>u.origin===target.origin && u.pathname.replace(/\/$/,'')===target.pathname.replace(/\/$/,'') && u.search===target.search && u.hash===target.hash);
  const result=await chrome.tabs.sendMessage(scannerId,{type:'ARCHIVE_SCAN',mode,lesson});
  if(!result?.ok)throw Error(result?.error || 'Book scanner did not respond. Reload Relay Rook and start again.');
  return result;
}
async function courseLessons(course) {
  const result=[];
  for(const chapter of course.chapters || [])for(const meta of chapter.lessons || []){
    const lesson=await record(`lesson:${course.id}:${meta.id}`);
    if(!lesson)throw Error(`Lesson ${meta.title} has not been saved.`);
    result.push({...lesson,chapter:chapter.title,chapterOrder:chapter.order,order:meta.order});
  }
  if(!course.complete || result.length!==course.total)throw Error('The book is incomplete. Resume its scan before exporting or uploading.');
  return result;
}
async function download(filename,contents,type) {
  const url=URL.createObjectURL(new Blob([contents],{type}));
  try{
    const id=await chrome.downloads.download({url,filename,saveAs:false,conflictAction:'uniquify'});
    for(let i=0;i<120;i++){
      const [item]=await chrome.downloads.search({id});
      if(item?.state==='complete')return id;
      if(item?.state==='interrupted')throw Error(`Download failed: ${item.error}`);
      await delay(500);
    }
    throw Error('Chrome has not finished saving the book. Check Downloads.');
  }finally{URL.revokeObjectURL(url);}
}
async function saveBook(course) {
  const lessons=await courseLessons(course), folder=`Relay Rook Books/${Book.safeName(course.title)} [${course.id}]`;
  stage(`Saving ${course.title} · ${lessons.length} lessons`);
  for(let i=0;i<lessons.length;i+=64)await download(`${folder}/Book ${String(i/64+1).padStart(2,'0')}.pgn`,lessons.slice(i,i+64).map(Book.pgn).join('\n'),'application/x-chess-pgn');
  await download(`${folder}/Book.html`,Book.html(course,lessons),'text/html');
  await download(`${folder}/Source.json`,JSON.stringify({course,lessons},null,2),'application/json');
  course.downloaded=new Date().toISOString();await record(`course:${course.id}`,course);
  log(`Saved PGN, readable book and source archive for ${course.title}.`);
}
async function access() {
  const instance=Book.instance($('instance').value);
  const granted=await chrome.permissions.request({origins:[Book.permission(instance)]});
  if(!granted)throw Error('Access to the selected Lichess instance was not granted.');
  await chrome.storage.local.set({bookInstance:instance,bookPriority:$('course').value});
  return instance;
}
async function step(action,payload) {
  const [{result}]=await chrome.scripting.executeScript({target:{tabId:studyTabId},func:lichessStep,args:[action,payload]});
  if(!result?.ok)throw Error(result?.error || 'Lichess did not respond.');
  return result;
}
async function importBook(course) {
  const instance=Book.instance($('instance').value), origin=new URL(instance).origin;
  if(!await chrome.permissions.contains({origins:[Book.permission(instance)]}))throw Error('Select this Lichess instance and start from the archive button to grant access.');
  const source=await courseLessons(course), lessons=Book.forLichess(source);
  if(lessons.length!==source.length || source.some(l=>l.tokens.some(t=>t.kind==='move' && t.san==='--')))log(`Prepared ${lessons.length} Lichess chapters from ${source.length} lessons; null moves are split at their recorded positions. Original PGNs remain in the local archive.`);
  course.studies ||= [];
  for(let i=0;i<lessons.length;i+=64){
    if(stopping)throw Error('Upload stopped. Saved books and completed studies are retained.');
    const part=i/64+1, pgn=lessons.slice(i,i+64).map(Book.pgn).join('\n');
    const sourceHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(pgn)))].map(b=>b.toString(16).padStart(2,'0')).join('');
    let saved=course.studies.find(s=>s.instance===instance && s.part===part);
    if(saved?.sourceHash && saved.sourceHash!==sourceHash)throw Error(`Volume ${part}'s source changed. Inspect ${saved.url} before replacing existing study content.`);
    if(saved?.verified){log(`Volume ${part} already verified at ${saved.url}`);continue;}
    stage(`Creating private study · ${course.title} · volume ${part}`);
    const tab=await chrome.tabs.create({url:saved?.url || instance+'study',active:false});studyTabId=tab.id;
    await waitTab(studyTabId,u=>u.origin===origin && u.pathname.startsWith('/study'));
    if(!saved){
      await step('open',{origin});
      const created=await waitTab(studyTabId,u=>u.origin===origin && /^\/study\/[A-Za-z0-9]{8}(?:\/[A-Za-z0-9]{8})?$/.test(u.pathname));
      const id=new URL(created.url).pathname.split('/')[2];
      saved={instance,part,id,url:instance+'study/'+id,verified:false,sourceHash};course.studies.push(saved);
      await record(`course:${course.id}`,course);
    }
    if(!saved.configured){
      await step('configure',{origin,name:`${course.title} · Book ${part}`.slice(0,100)});
      saved.configured=true;await record(`course:${course.id}`,course);
    }
    await step('privacy',{origin});
    if(!saved.attempted){
      saved.attempted=true;await record(`course:${course.id}`,course);
      await step('import',{origin,id:saved.id,pgn});
    }
    const exported=await step('export',{origin,id:saved.id});
    if(JSON.stringify(Book.signature(pgn))!==JSON.stringify(Book.signature(exported.pgn)))throw Error(`Volume ${part} did not preserve every position, move and comment in the Lichess export. Its local source is retained; inspect ${saved.url}.`);
    saved.verified=true;await record(`course:${course.id}`,course);
    log(`Verified private volume ${part}: ${saved.url}`);await render();
    await chrome.tabs.update(studyTabId,{url:saved.url});studyTabId=null;
    if(i+64<lessons.length){stage('Waiting 60 seconds before the next volume.');for(let j=0;j<60 && !stopping;j++)await delay(1000);}
  }
}
async function scan(all) {
  const priority=$('course').value.trim();
  if(!/^\d+$/.test(priority))throw Error('Enter a numeric priority course ID.');
  stage('Reading the Chessable library…');
  const library=await scanPage('https://www.chessable.com/','library');
  let courses=library.courses.sort((a,b)=>Number(b.id===priority)-Number(a.id===priority));
  if(!all){courses=courses.filter(c=>c.id===priority);if(!courses.length)throw Error('The selected course is not in your library.');}
  for(const item of courses){
    if(stopping)break;
    const old=await record(`course:${item.id}`), course={...item,studies:old?.studies || [],saved:0,total:0,complete:false,chapters:[]};
    let failures=0;
    try{
      stage(`Reading chapters · ${course.title}`);
      const {chapters}=await scanPage(course.url,'chapters');course.chapters=chapters;
      for(const chapter of chapters){
        if(stopping)break;
        try{
          stage(`Reading ${course.title} · ${chapter.title}`);
          chapter.lessons=(await scanPage(chapter.url,'lessons')).lessons;course.total+=chapter.lessons.length;
          for(const meta of chapter.lessons){
            if(stopping)break;
            try{
              const key=`lesson:${course.id}:${meta.id}`;
              if(!await record(key)){
                stage(`Saving ${course.title} · ${chapter.title} · ${meta.title}`);
                const result=await scanPage(meta.url,'lesson',{...meta,courseId:course.id,course:course.title,chapterId:chapter.id,chapter:chapter.title,chapterOrder:chapter.order});
                await record(key,result.lesson);
              }
              course.saved++;
            }catch(error){failures++;issue(`${meta.title}: ${error.message}`);}
            await record(`course:${course.id}`,course);await render();
          }
        }catch(error){failures++;issue(`${chapter.title}: ${error.message}`);}
      }
      course.complete=!stopping && !failures && course.total>0 && course.total===course.saved;
      await record(`course:${course.id}`,course);await render();
      if(course.complete){await saveBook(course);if($('upload').checked)await importBook(course);}
      else log(`${course.title} remains incomplete; ${course.saved}/${course.total} lessons saved.`,'error');
    }catch(error){issue(`${course.title}: ${error.message}`);}
  }
  stage(`${stopping?'Stopped':'Scan finished'} · ${report.issues.length} issues. Check each book’s status before going offline.`);
}
async function exclusive(action) {
  try{
    await navigator.locks.request('relay-rook-books',{ifAvailable:true},async lock=>{
      if(!lock)throw Error('Another book archive tab is already working.');
      running=true;stopping=false;$('start').disabled=$('selected').disabled=true;$('stop').disabled=false;
      $('instance').disabled=$('course').disabled=$('upload').disabled=true;await render();
      try{await action();}finally{
        if(scannerId!==null)await chrome.tabs.remove(scannerId).catch(()=>{});
        scannerId=null;running=false;$('start').disabled=$('selected').disabled=false;$('stop').disabled=true;
        $('instance').disabled=$('course').disabled=$('upload').disabled=false;await render();
      }
    });
  }catch(error){issue(error.message);$('status').textContent=error.message;}
}
async function start(all){
  try{if($('upload').checked)await access();await exclusive(()=>scan(all));}catch(error){issue(error.message);$('status').textContent=error.message;}
}
$('start').onclick=()=>start(true);$('selected').onclick=()=>start(false);
$('stop').onclick=()=>{stopping=true;$('stop').disabled=true;log('Stopping after the current operation.');};
$('report').onclick=()=>download('Relay Rook Books/Scan report.json',JSON.stringify(report,null,2),'application/json').catch(e=>issue(e.message));
window.addEventListener('beforeunload',event=>{if(running){event.preventDefault();event.returnValue='';}});
(async()=>{
  const saved=await chrome.storage.local.get(['bookInstance','bookPriority','bookReport']);
  $('instance').value=saved.bookInstance || 'https://lichess.org/';
  $('course').value=new URL(location.href).searchParams.get('course') || saved.bookPriority || '258968';
  if(saved.bookReport)report=saved.bookReport;
  log('Book archive ready.');await render();
})().catch(e=>{$('status').textContent=e.message;});

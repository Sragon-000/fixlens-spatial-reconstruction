import {AssemblyEngine, demoScene} from './engine.mjs';
const $ = id => document.getElementById(id);
const canvas = $('canvas'), ctx = canvas.getContext('2d'), video = $('video');
const engine = new AssemblyEngine();
let mode = 'demo', scenario = 'normal', stream = null, generation = 0;
let paused = false, virtualTime = 0, lastTick = null, tool = 'target', drag = null;
let boxes = {}, lastMessage = '', hidden = document.hidden;
const labels = {SCAN:'위치 확인', GUIDE:'슬롯으로 이동', ERROR_CHECK:'정상 위치 유지', COMPLETE:'직접 체결 확인'};
const clamp = (n,min,max) => Math.max(min,Math.min(max,n));
function reset() { engine.reset(); virtualTime=0; lastTick=null; lastMessage=''; }
function stopCamera(message = '카메라가 꺼져 있습니다.') {
  generation++;
  if(stream) stream.getTracks().forEach(t=>t.stop());
  stream=null; video.srcObject=null; boxes={}; drag=null;
  $('tools').disabled=true; $('stopCamera').disabled=true; $('startCamera').disabled=false;
  $('cameraMessage').textContent=message; reset();
}
function setMode(next) {
  stopCamera(); mode=next; paused=false;
  $('pause').textContent='일시정지';
  $('demoMode').setAttribute('aria-pressed',next==='demo');
  $('cameraMode').setAttribute('aria-pressed',next==='camera');
  $('demoControls').hidden=next!=='demo'; $('cameraControls').hidden=next!=='camera';
  $('sourceLabel').textContent=next==='demo'?'시뮬레이션 입력':'카메라 · 수동 위치 입력';
  $('canvasTag').textContent=next==='demo'?'DEMO / 합성 위치':'MANUAL / 자동 추적 없음';
  $('stage').style.aspectRatio='16 / 9'; reset();
}
async function startCamera() {
  stopCamera('카메라 접근 권한을 기다리고 있습니다.');
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    $('cameraMessage').textContent='카메라는 HTTPS 주소 또는 이 컴퓨터의 localhost에서 사용할 수 있습니다. 보안 주소로 접속하거나 데모를 이용하세요.'; return;
  }
  const request=++generation; $('startCamera').disabled=true;
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:$('facing').value},width:{ideal:1280},height:{ideal:720}}});
    if(request!==generation || mode!=='camera') { acquired.getTracks().forEach(t=>t.stop()); return; }
    stream=acquired; video.srcObject=acquired;
    await video.play();
    if(request!==generation) return;
    $('stage').style.aspectRatio=`${video.videoWidth || 1280} / ${video.videoHeight || 720}`;
    $('tools').disabled=false; $('stopCamera').disabled=false; $('startCamera').disabled=false;
    $('cameraMessage').textContent='① 타겟 슬롯 → ② 다른 슬롯(선택) → ③ RAM 순서로 사각형을 그리세요. RAM 이동 도구나 슬라이더로 위치를 갱신합니다. 실제 부품 움직임은 자동 추적하지 않습니다.';
    stream.getVideoTracks().forEach(track=>track.addEventListener('ended',()=>{if(request===generation) stopCamera('카메라 연결이 종료되었습니다. 다시 켜주세요.');}));
    reset();
  } catch(error) {
    if(request!==generation) return;
    const messages={NotAllowedError:'카메라 권한이 차단되었습니다. 브라우저 사이트 권한에서 허용한 뒤 다시 켜주세요.',NotFoundError:'사용할 수 있는 카메라를 찾지 못했습니다. 데모로 흐름을 확인할 수 있습니다.',NotReadableError:'카메라를 열 수 없습니다. 다른 앱에서 사용 중인지 확인하세요.'};
    stopCamera(messages[error.name] || '카메라 연결에 실패했습니다. 권한과 기기 연결을 확인하고 다시 시도하세요.');
  }
}
function observation() {
  if(mode==='demo') return demoScene(scenario,virtualTime);
  return {ram:stream && !$('hiddenRam').checked ? boxes.ram : null,target:stream?boxes.target:null,others:boxes.other?[boxes.other]:[],reversed:$('reversed').checked};
}
function rect(box,color,label,dashed=false) {
  if(!box) return;
  ctx.save();ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=3;
  ctx.setLineDash(dashed?[10,7]:[]);ctx.strokeRect(box.x,box.y,box.w,box.h);
  ctx.globalAlpha=.1;ctx.fillRect(box.x,box.y,box.w,box.h);ctx.globalAlpha=1;
  ctx.font='20px sans-serif';ctx.fillText(label,box.x,Math.max(28,box.y-12));ctx.restore();
}
function render(scene,status) {
  ctx.clearRect(0,0,1280,720);
  rect(scene.target,'#b4f786','TARGET');scene.others.forEach(b=>rect(b,'#a5b7c2','OTHER',true));
  rect(scene.ram,status.warning?'#ff9d83':'#ffd786',scene.reversed?'RAM · REVERSED':'RAM');
  if(scene.ram && scene.target && status.state!=='COMPLETE') {
    const x=scene.ram.x+scene.ram.w/2,y=scene.ram.y+scene.ram.h;
    const tx=scene.target.x+scene.target.w/2,ty=scene.target.y;
    if(Math.hypot(tx-x,ty-y)>30) {
      const a=Math.atan2(ty-y,tx-x);ctx.strokeStyle='#b4f786';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(tx,ty);
      ctx.moveTo(tx-18*Math.cos(a-.4),ty-18*Math.sin(a-.4));ctx.lineTo(tx,ty);ctx.lineTo(tx-18*Math.cos(a+.4),ty-18*Math.sin(a+.4));ctx.stroke();
    }
  }
  const states=Object.keys(labels),current=states.indexOf(status.state);
  document.querySelectorAll('#steps li').forEach((li,i)=>{li.classList.toggle('active',i===current);li.classList.toggle('done',i<current);if(i===current)li.setAttribute('aria-current','step');else li.removeAttribute('aria-current');});
  $('stateLabel').textContent=labels[status.state];
  if(lastMessage!==status.message){$('message').textContent=status.message;lastMessage=status.message;}
  $('statusCard').classList.toggle('warning',!!status.warning);
  $('progress').value=status.progress;
  $('elapsed').replaceChildren(document.createTextNode((status.elapsed/1000).toFixed(1)),Object.assign(document.createElement('small'),{textContent:'초'}));
  $('errors').replaceChildren(document.createTextNode(String(status.errors)),Object.assign(document.createElement('small'),{textContent:'회'}));
}
function tick(now) {
  const delta=lastTick===null?0:Math.min(100,now-lastTick);lastTick=now;
  if(!paused && !hidden && !drag)virtualTime+=delta;
  const scene=observation();
  const status=(!paused && !hidden && !drag)?engine.update(scene,virtualTime):engine.snapshot();
  render(scene,status);requestAnimationFrame(tick);
}
function point(e){const r=canvas.getBoundingClientRect();return{x:clamp((e.clientX-r.left)/r.width*1280,0,1280),y:clamp((e.clientY-r.top)/r.height*720,0,720)};}
canvas.addEventListener('pointerdown',e=>{
  if(mode!=='camera'||!stream)return;
  if(tool==='move'&&!boxes.ram){$('cameraMessage').textContent='먼저 RAM 영역을 그려주세요.';return;}
  canvas.setPointerCapture(e.pointerId);drag={start:point(e),original:boxes.ram?{...boxes.ram}:null,before:boxes[tool]?{...boxes[tool]}:null};
  if(engine.state==='COMPLETE')reset();
});
canvas.addEventListener('pointermove',e=>{
  if(!drag)return;const p=point(e),s=drag.start;
  if(tool==='move') boxes.ram={...drag.original,x:clamp(drag.original.x+p.x-s.x,0,1280-drag.original.w),y:clamp(drag.original.y+p.y-s.y,0,720-drag.original.h)};
  else boxes[tool]={x:Math.min(s.x,p.x),y:Math.min(s.y,p.y),w:Math.abs(p.x-s.x),h:Math.abs(p.y-s.y)};
  syncSliders();
});
canvas.addEventListener('pointerup',()=>{
  if(!drag)return;
  if(tool!=='move'&&(!boxes[tool]||boxes[tool].w<12||boxes[tool].h<12)){
    if(drag.before)boxes[tool]=drag.before;else delete boxes[tool];
    $('cameraMessage').textContent='영역이 너무 작습니다. 부품의 양 끝을 드래그해 다시 지정하세요.';
  }
  drag=null;engine.holdAt=null;syncSliders();
});
canvas.addEventListener('pointercancel',()=>{if(drag){if(tool==='move')boxes.ram=drag.original;else if(drag.before)boxes[tool]=drag.before;else delete boxes[tool];}drag=null;engine.holdAt=null;});
function syncSliders(){if(!boxes.ram)return;$('ramX').value=boxes.ram.x/(1280-boxes.ram.w)*100;$('ramY').value=boxes.ram.y/(720-boxes.ram.h)*100;}
for(const [id,axis,dimension] of [['ramX','x',1280],['ramY','y',720]])$(id).addEventListener('input',()=>{if(!boxes.ram)return;if(engine.state==='COMPLETE')reset();boxes.ram[axis]=Number($(id).value)/100*(dimension-boxes.ram[axis==='x'?'w':'h']);engine.holdAt=null;});
document.querySelectorAll('[data-tool]').forEach(button=>button.addEventListener('click',()=>{tool=button.dataset.tool;document.querySelectorAll('[data-tool]').forEach(b=>b.setAttribute('aria-pressed',b===button));}));
$('demoMode').onclick=()=>setMode('demo');$('cameraMode').onclick=()=>setMode('camera');
$('startCamera').onclick=startCamera;$('stopCamera').onclick=()=>stopCamera();
$('facing').onchange=()=>{if(stream)startCamera();};
$('scenario').onchange=()=>{scenario=$('scenario').value;paused=false;$('pause').textContent='일시정지';reset();};
$('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'계속하기':'일시정지';engine.holdAt=null;lastTick=null;};
$('reset').onclick=()=>{reset();};$('clearBoxes').onclick=()=>{boxes={};reset();};
for(const id of ['reversed','hiddenRam'])$(id).onchange=()=>{if(engine.state==='COMPLETE')reset();engine.holdAt=null;};
document.addEventListener('visibilitychange',()=>{hidden=document.hidden;lastTick=null;engine.scanAt=null;engine.holdAt=null;if(hidden&&engine.state!=='COMPLETE')engine.state='SCAN';});
window.addEventListener('pagehide',()=>stopCamera());
requestAnimationFrame(tick);

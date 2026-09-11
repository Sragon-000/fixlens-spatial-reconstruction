import {FrameGate} from './frame-gate.mjs';
import {DetectionState} from './detection-state.mjs';
const $=id=>document.getElementById(id),video=$('video'),canvas=$('canvas'),ctx=canvas.getContext('2d');
const capture=document.createElement('canvas'),captureContext=capture.getContext('2d',{willReadFrequently:true});
const gate=new FrameGate(),detections=new DetectionState();
let stream=null,generation=0,worker=null,ready=false,loadTimer=null,lastRequest=-Infinity,videoSize='',lastList='';
const names={person:'사람',bottle:'병',cup:'컵','cell phone':'휴대폰',mouse:'마우스',keyboard:'키보드',laptop:'노트북',book:'책',chair:'의자',scissors:'가위',clock:'시계',remote:'리모컨',tv:'TV',bowl:'그릇',banana:'바나나',apple:'사과',dog:'개',cat:'고양이',backpack:'배낭'};
function modelMessage(message){$('modelMessage').textContent=message;}
function clearInput(){gate.reset();detections.clear();ctx.clearRect(0,0,canvas.width,canvas.height);}
function stopCamera(message='카메라가 꺼져 있습니다.') {
  generation++;if(stream)stream.getTracks().forEach(t=>t.stop());
  stream=null;video.srcObject=null;videoSize='';clearInput();
  $('cameraEmpty').hidden=false;$('canvasTag').hidden=true;$('startCamera').disabled=false;$('stopCamera').disabled=true;
  $('sourceLabel').textContent='연결 대기';$('emptyTitle').textContent='카메라를 연결하세요';$('cameraMessage').textContent=message;
}
async function startCamera(){
  stopCamera('카메라 권한을 허용해 주세요.');
  if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){$('cameraMessage').textContent='HTTPS 주소에서 Chrome 또는 Safari로 열고 카메라 권한을 허용하세요.';return;}
  const request=++generation;$('startCamera').disabled=true;$('stopCamera').disabled=false;$('emptyTitle').textContent='카메라 연결 중';
  try{
    const acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:$('facing').value},width:{ideal:1280},height:{ideal:720}}});
    if(request!==generation){acquired.getTracks().forEach(t=>t.stop());return;}
    stream=acquired;video.srcObject=acquired;await video.play();if(request!==generation)return;
    $('cameraEmpty').hidden=true;$('canvasTag').hidden=false;$('startCamera').disabled=false;
    $('cameraMessage').textContent='병·컵·책 같은 물체를 비추세요. AI가 이 기기에서 자동으로 위치와 종류를 인식합니다.';
    acquired.getVideoTracks().forEach(t=>t.addEventListener('ended',()=>{if(request===generation)stopCamera('카메라 연결이 종료되었습니다. 다시 연결하세요.');}));
    clearInput();if(!worker)loadModel();
  }catch(error){if(request!==generation)return;const messages={NotAllowedError:'카메라 권한이 차단되었습니다. 사이트 권한에서 허용하고 다시 연결하세요.',NotFoundError:'카메라를 찾지 못했습니다. 카메라가 있는 기기나 연결된 웹캠을 사용하세요.',NotReadableError:'다른 앱에서 카메라를 사용 중인지 확인하세요.'};stopCamera(messages[error.name]||'카메라 연결에 실패했습니다. 다시 시도하세요.');}
}
function failModel(message){
  if(worker)worker.terminate();worker=null;ready=false;clearTimeout(loadTimer);detections.pending=null;detections.clear();
  modelMessage(message);$('retryModel').hidden=false;$('modelBadge').textContent='연결 필요';
}
function loadModel(){
  if(worker)worker.terminate();clearTimeout(loadTimer);detections.pending=null;detections.clear();ready=false;
  $('retryModel').hidden=true;$('modelBadge').textContent='준비 중';modelMessage('AI 모델을 불러오고 있습니다. 첫 실행은 잠시 걸릴 수 있습니다.');
  try{worker=new Worker('./inference-worker.js');}catch(_){failModel('이 브라우저에서 AI 실행을 시작하지 못했습니다. 다른 최신 브라우저로 열어주세요.');return;}
  const current=worker;
  loadTimer=setTimeout(()=>{if(worker===current)failModel('모델 준비 시간이 초과됐습니다. 연결 상태를 확인하고 다시 시도하세요.');},90000);
  worker.onerror=()=>{if(worker===current)failModel('AI 실행 중 오류가 발생했습니다. 다시 시도하세요.');};
  worker.onmessage=({data})=>{
    if(worker!==current)return;
    if(data.type==='ready'){clearTimeout(loadTimer);ready=true;$('modelBadge').textContent='기기 내 실행';$('backend').textContent=data.backend==='wasm'?'WebAssembly 가속':data.backend==='webgl'?'GPU 가속':'CPU 실행';modelMessage('AI 준비 완료. 카메라 영상에서 일상 물체를 인식합니다.');}
    else if(data.type==='load-error'||data.type==='inference-error')failModel('AI 실행에 실패했습니다. 카메라는 유지됩니다. 모델을 다시 불러오세요.');
    else if(data.type==='result'){
      const now=performance.now();const accepted=detections.accept(data,now);
      if(!accepted){if(stream&&ready)modelMessage('이전 또는 지연된 결과를 제외했습니다. 물체와 카메라를 잠시 고정하세요.');return;}
      $('latency').textContent=`${Math.round(data.ms)} ms`;
      modelMessage(data.ms>800?'인식 속도가 느립니다. 물체와 카메라를 잠시 고정하세요.':'이 기기에서 인식 중입니다. 물체를 움직여 박스가 따라오는지 확인하세요.');
    }
  };worker.postMessage({type:'load'});
}
function draw(results){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const scale=canvas.width/640;ctx.lineWidth=2.5*scale;ctx.font=`${16*scale}px sans-serif`;
  for(const p of results){
    const x=p.x*canvas.width,y=p.y*canvas.height,w=p.w*canvas.width,h=p.h*canvas.height;
    const label=`${names[p.name]||p.name} ${Math.round(p.score*100)}%`,textW=ctx.measureText(label).width;
    ctx.strokeStyle='#b4f786';ctx.strokeRect(x,y,w,h);
    const labelX=Math.max(0,Math.min(x,canvas.width-textW-12*scale)),labelY=Math.max(0,y-28*scale);
    ctx.fillStyle='#b4f786';ctx.fillRect(labelX,labelY,textW+12*scale,27*scale);ctx.fillStyle='#152413';ctx.fillText(label,labelX+6*scale,labelY+19*scale);
  }
  $('count').textContent=String(results.length);
  const key=JSON.stringify(results.map(p=>[p.name,Math.round(p.score*100)]))+Boolean(stream&&ready);
  if(key!==lastList){lastList=key;const list=$('objects');list.replaceChildren();
    if(!results.length){const li=document.createElement('li');li.className='empty-result';li.textContent=stream&&ready?'인식된 물체가 없습니다. 밝은 곳에서 병·컵·책을 비춰보세요.':'카메라와 AI가 준비되면 결과가 표시됩니다.';list.append(li);}
    for(const p of results){const li=document.createElement('li'),name=document.createElement('span'),score=document.createElement('strong');name.textContent=names[p.name]||p.name;score.textContent=`${Math.round(p.score*100)}%`;li.append(name,score);list.append(li);}
  }
}
function tick(now){
  const size=`${video.videoWidth}x${video.videoHeight}`;
  if(stream&&video.videoWidth&&video.videoHeight&&size!==videoSize){videoSize=size;canvas.width=video.videoWidth;canvas.height=video.videoHeight;$('stage').style.aspectRatio=`${canvas.width} / ${canvas.height}`;clearInput();}
  const frame=gate.sample(video,stream?.getVideoTracks()[0],now);
  const active=!!stream&&frame.fresh&&!document.hidden;
  if(!active&&(detections.results.length||detections.pending?.epoch===detections.epoch))detections.clear();
  if(stream)$('sourceLabel').textContent=active?'실시간 연결됨':'영상 입력 대기';
  if(detections.pending&&now-detections.pending.capturedAt>20000)failModel('AI 응답 시간이 초과됐습니다. 다시 불러오세요.');
  if(active&&frame.changed&&ready&&!detections.pending&&now-lastRequest>=120){
    const ratio=Math.min(1,640/video.videoWidth,480/video.videoHeight);
    capture.width=Math.max(1,Math.round(video.videoWidth*ratio));capture.height=Math.max(1,Math.round(video.videoHeight*ratio));
    try{
      captureContext.drawImage(video,0,0,capture.width,capture.height);
      const image=captureContext.getImageData(0,0,capture.width,capture.height),job=detections.begin(now,capture.width,capture.height);
      lastRequest=now;worker.postMessage({type:'detect',...job,pixels:image.data.buffer},[image.data.buffer]);
    }catch(_){failModel('영상 프레임을 AI에 전달하지 못했습니다. 다시 시도하세요.');}
  }
  draw(active?detections.visible(now):[]);requestAnimationFrame(tick);
}
$('startCamera').onclick=startCamera;$('stopCamera').onclick=()=>stopCamera();$('facing').onchange=()=>{if(stream)startCamera();};$('retryModel').onclick=loadModel;
document.addEventListener('visibilitychange',()=>{clearInput();lastList='';});
window.addEventListener('pagehide',()=>{stopCamera();if(worker)worker.terminate();worker=null;ready=false;clearTimeout(loadTimer);detections.pending=null;});
requestAnimationFrame(tick);

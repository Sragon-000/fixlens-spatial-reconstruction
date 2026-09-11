import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('camera permission, video connection, stop, denial and cancelled request', async()=>{
  // DOM/media adapters exercise the actual app handlers without physical hardware.
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,{
    hidden:false,disabled:false,value:'environment',style:{},textContent:'',
    addEventListener(){},getContext(){return{clearRect(){}};}
  }]));
  globalThis.document={hidden:false,getElementById:id=>{assert.ok(elements.has(id),id);return elements.get(id);},querySelectorAll:()=>[],createElement:()=>({getContext:()=>({})}),addEventListener(){}};
  globalThis.window={isSecureContext:true,addEventListener(){}};
  globalThis.requestAnimationFrame=()=>{};
  globalThis.Worker=class {postMessage(){this.onmessage({data:{type:'ready',backend:'cpu'}});}terminate(){}};
  const video=elements.get('video');video.videoWidth=1280;video.videoHeight=720;
  video.play=async()=>{video.paused=false;};
  let stopped=0,requested;
  const track={stop(){stopped++;},addEventListener(){}};
  const stream={getTracks:()=>[track],getVideoTracks:()=>[track]};
  const mediaDevices={getUserMedia:async constraints=>{requested=constraints;return stream;}};
  Object.defineProperty(globalThis,'navigator',{value:{mediaDevices},configurable:true});
  await import('../dist/app.mjs');
  const start=elements.get('startCamera'),stop=elements.get('stopCamera');
  await start.onclick();
  assert.equal(video.srcObject,stream);assert.equal(requested.audio,false);
  assert.equal(requested.video.facingMode.ideal,'environment');
  assert.equal(elements.get('cameraEmpty').hidden,true);

  stop.onclick();assert.equal(stopped,1);assert.equal(video.srcObject,null);
  assert.equal(elements.get('cameraEmpty').hidden,false);
  mediaDevices.getUserMedia=async()=>{throw Object.assign(new Error(),{name:'NotAllowedError'});};
  await start.onclick();assert.match(elements.get('cameraMessage').textContent,/권한이 차단/);assert.equal(start.disabled,false);
  let resolve;
  mediaDevices.getUserMedia=()=>new Promise(r=>{resolve=r;});
  const pending=start.onclick();stop.onclick();resolve(stream);await pending;
  assert.equal(stopped,2);assert.equal(video.srcObject,null);
  window.isSecureContext=false;await start.onclick();
  assert.match(elements.get('cameraMessage').textContent,/HTTPS/);
});

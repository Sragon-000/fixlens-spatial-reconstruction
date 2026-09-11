import test from 'node:test';
import assert from 'node:assert/strict';
import {FrameGate} from '../dist/frame-gate.mjs';
import {AssemblyEngine} from '../dist/engine.mjs';

test('frozen video never completes despite repeated display refreshes',()=>{
  const gate=new FrameGate(),engine=new AssemblyEngine();
  const video={paused:false,readyState:4,currentTime:0};
  const track={readyState:'live',muted:false};
  const scene={ram:{x:100,y:300,w:100,h:40},target:{x:100,y:300,w:100,h:40}};
  const tick=now=>{const frame=gate.sample(video,track,now);if(!frame.fresh)engine.interrupt();else if(frame.changed)engine.update(scene,now);};
  for(let now=0;now<=500;now+=50){video.currentTime=now/1000;tick(now);}
  assert.equal(engine.state,'ERROR_CHECK');
  for(let now=550;now<=3000;now+=16)tick(now);
  assert.equal(engine.state,'SCAN');assert.equal(engine.progress,0);
  for(let now=3050;now<=3550;now+=50){video.currentTime=now/1000;tick(now);assert.notEqual(engine.state,'COMPLETE');}
  for(let now=3600;now<=3900;now+=50){video.currentTime=now/1000;tick(now);}
  assert.equal(engine.state,'COMPLETE');
});
test('muted, ended, paused or unavailable video is rejected',()=>{
  for(const [v,t] of [[{paused:true},{}],[{readyState:1},{}],[{}, {muted:true}],[{}, {readyState:'ended'}]]){
    const gate=new FrameGate();
    const result=gate.sample({paused:false,readyState:4,currentTime:1,...v},{readyState:'live',muted:false,...t},1000);
    assert.equal(result.fresh,false);
  }
});

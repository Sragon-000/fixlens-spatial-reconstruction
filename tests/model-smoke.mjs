// Run the shipped worker/runtime/model with a CPU adapter. No simulated detector.
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../dist/',import.meta.url));
const server=createServer(async(req,res)=>{
  const file=path.resolve(root,'.'+decodeURIComponent(req.url));
  if(!file.startsWith(root)){res.writeHead(403).end();return;}
  try{if(file.endsWith('.wasm'))res.setHeader('Content-Type','application/wasm');res.end(await readFile(file));}catch(_){res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const messages=[];
const context=vm.createContext({WorkerGlobalScope:class {},navigator:{userAgent:"Node model test"},console,fetch,URL,TextEncoder,TextDecoder,performance,setTimeout,clearTimeout,ArrayBuffer,Uint8Array,Uint8ClampedArray,Float32Array,Int32Array});
context.self=context;context.location={href:origin+'/inference-worker.js'};
context.postMessage=message=>messages.push(message);
context.importScripts=(...urls)=>urls.forEach(url=>vm.runInContext(readFileSync(path.resolve(root,url),'utf8'),context));
try{
  vm.runInContext(await readFile(path.join(root,'inference-worker.js'),'utf8'),context);
  await context.onmessage({data:{type:'load'}});
  assert.equal(messages[0]?.type,'ready',JSON.stringify(messages));
  await context.onmessage({data:{type:'detect',id:1,width:300,height:300,pixels:new Uint8Array(300*300*4).buffer}});
  assert.equal(messages[1]?.type,'result',JSON.stringify(messages));
  assert.ok(Array.isArray(messages[1].results));
  if(process.argv[2]) {
    const pixels=new Uint8Array(await readFile(process.argv[2]));
    await context.onmessage({data:{type:'detect',id:2,width:Number(process.argv[3]),height:Number(process.argv[4]),pixels:pixels.buffer}});
    assert.equal(messages[2]?.type,'result',JSON.stringify(messages[2]));
    assert.ok(messages[2].results.length>0,'Expected actual objects in the reference image');
    console.log('Reference image:',JSON.stringify(messages[2].results));
    await context.onmessage({data:{type:'detect',detail:true,id:3,width:Number(process.argv[3]),height:Number(process.argv[4]),pixels:pixels.buffer}});
    assert.equal(messages[3]?.type,'result',JSON.stringify(messages[3]));
    console.log('Detail comparison:',JSON.stringify({full:messages[2].results.length,detail:messages[3].results.length,fullMs:Math.round(messages[2].ms),detailMs:Math.round(messages[3].ms)}));
  }
  console.log(JSON.stringify({actualModel:'COCO-SSD lite_mobilenet_v2',backend:messages[0].backend,inferenceMs:Math.round(messages[1].ms),detections:messages[1].results.length}));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

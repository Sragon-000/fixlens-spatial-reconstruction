export class DetectionState {
  constructor() { this.epoch=0; this.sequence=0; this.pending=null; this.clear(); }
  clear() { this.epoch++; this.results=[]; this.receivedAt=-Infinity; this.capturedAt=-Infinity; }
  begin(now,width,height) {
    if(this.pending) return null;
    this.pending={id:++this.sequence,epoch:this.epoch,capturedAt:now,width,height};
    return {...this.pending};
  }
  accept(message,now) {
    if(!this.pending || message.id!==this.pending.id) return false;
    const job=this.pending; this.pending=null;
    if(job.epoch!==this.epoch || now-job.capturedAt>2000) return false;
    this.results=(message.results||[]).filter(p=>Array.isArray(p.bbox)&&p.bbox.length===4&&p.bbox.every(Number.isFinite)&&Number.isFinite(p.score)&&p.score>=.5).map(p=>{
      const [x,y,w,h]=p.bbox;
      const left=Math.max(0,Math.min(1,x/job.width)),top=Math.max(0,Math.min(1,y/job.height));
      const right=Math.max(left,Math.min(1,(x+w)/job.width)),bottom=Math.max(top,Math.min(1,(y+h)/job.height));
      return {name:String(p.class),score:p.score,x:left,y:top,w:right-left,h:bottom-top};
    }).filter(p=>p.w>0&&p.h>0);
    this.receivedAt=now;this.capturedAt=job.capturedAt;return true;
  }
  visible(now) { return now-this.receivedAt<=650 && now-this.capturedAt<=2000 ? this.results : []; }
}

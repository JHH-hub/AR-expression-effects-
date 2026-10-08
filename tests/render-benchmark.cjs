const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.goto('http://127.0.0.1:8089/tests/render-smoke.html');
 const result=await page.evaluate(async()=>{
  const {GLRenderer}=await import('/src/glRenderer.js?v=20261008a');
  const canvas=document.querySelector('canvas'),r=new GLRenderer(canvas);
  r.setQuality(2);r.resize(390,540);r.setRain(.8);
  const gl=r.gl,info=gl.getExtension('WEBGL_debug_renderer_info');
  const gpu=info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):'unavailable';
  const h={x:195,y:290,rx:70,ry:90,valid:true};
  const mood={cool:.4,warm:.3,flash:0,shockX:0,shockY:0,shockR:0,shockLife:0,bloomBoost:1,shakeX:0,shakeY:0,beauty:0};let start=performance.now(),last=start,nextBurst=start;
  const samples=[];let frames=0;
  await new Promise(resolve=>{
   const loop=now=>{
    const elapsed=(now-last)/1000;last=now;if(elapsed>0 && now-start>5000)samples.push(elapsed*1000);
    h.prevX=h.x;h.prevY=h.y;h.prevRx=h.rx;h.prevRy=h.ry;h.prevValid=true;
    h.x=195+Math.sin(now/800)*70;r.setHead(h);
    if(now>=nextBurst){r.burst(195,100,1,.08,.8,.3);nextBurst=now+520;}
    r.render(Math.min(elapsed,.05),mood);frames++;
    if(now-start>=180000)resolve();else requestAnimationFrame(loop);
   };requestAnimationFrame(loop);
  });
  const total=performance.now()-start;samples.sort((a,b)=>a-b);
  const at=p=>samples[Math.floor((samples.length-1)*p)];
  const answer={scope:'Headless Edge renderer-only; synthetic moving head; no camera/inference; not human/device acceptance',viewport:'390x540 CSS px',quality:'HIGH',capacity:r.total || 65536,gpu,durationMs:total,frames,averageFps:frames/(total/1000),p50FrameMs:at(.5),p95FrameMs:at(.95),p99FrameMs:at(.99),glError:gl.getError()};
  r.dispose();return answer;
 });
 result.browser=await browser.version();result.date=new Date().toISOString();
 fs.mkdirSync('tmp/acceptance',{recursive:true});fs.writeFileSync('tmp/acceptance/benchmark.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1;});

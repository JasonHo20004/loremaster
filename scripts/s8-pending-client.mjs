export function pendingHttpClientScript(host = 'api', port = 3000) {
  return `const http=require('http');let opened=false;
    const timer=setTimeout(()=>process.exit(2),25000);
    const call=http.request({host:${JSON.stringify(host)},port:${port},path:'/api/v1/session',method:'POST',
    headers:{'content-type':'application/json',origin:'http://localhost:8080',
    'transfer-encoding':'chunked',expect:'100-continue'}});
    call.on('continue',()=>{opened=true;call.write('{');console.log('OPEN');});
    call.on('response',response=>response.resume());
    call.on('error',()=>{if(!opened){console.log('ERROR');process.exitCode=2;}});
    call.on('close',()=>{console.log('CLOSED');clearTimeout(timer);});
    call.flushHeaders();`
}

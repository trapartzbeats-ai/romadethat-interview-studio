// Renders build/icon.png (1024²) with the app's own fonts. Run: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const font = (f) => 'data:font/ttf;base64,' + fs.readFileSync(path.join(root, 'src/renderer/fonts', f)).toString('base64');
const html = `<html><body style="margin:0;background:transparent"><style>@font-face{font-family:Anton;src:url(${font('Anton-Regular.ttf')})}</style><canvas id=c width=1024 height=1024></canvas><script>
document.fonts.load('600px Anton').then(()=>{
 const c=document.getElementById('c'),x=c.getContext('2d');
 const r=200, m=64, s=1024-2*m;
 x.beginPath(); x.roundRect(m,m,s,s,r);
 const g=x.createLinearGradient(0,m,0,m+s); g.addColorStop(0,'#1B1B22'); g.addColorStop(1,'#050506'); x.fillStyle=g; x.fill();
 x.save(); x.clip();
 const glow=x.createRadialGradient(780,860,0,780,860,520); glow.addColorStop(0,'rgba(200,255,46,0.22)'); glow.addColorStop(1,'rgba(200,255,46,0)'); x.fillStyle=glow; x.fillRect(0,0,1024,1024);
 x.strokeStyle='rgba(200,255,46,0.55)'; x.lineWidth=10; x.beginPath(); x.moveTo(905,m); x.lineTo(770,m+s); x.stroke();
 x.restore();
 x.lineWidth=3; x.strokeStyle='rgba(255,255,255,0.10)'; x.beginPath(); x.roundRect(m+1.5,m+1.5,s-3,s-3,r); x.stroke();
 x.font='640px Anton'; x.fillStyle='#FFFFFF'; x.textBaseline='alphabetic'; x.textAlign='left';
 const w=x.measureText('R').width; const left=(1024-w-150)/2;
 x.fillText('R',left,800);
 x.fillStyle='#C8FF2E'; x.fillRect(left+w+34,688,112,112);
 window.png=c.toDataURL('image/png');
});
</script></body></html>`;
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 1024, height: 1024, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  let png = null;
  for (let i = 0; i < 50 && !png; i++) { png = await w.webContents.executeJavaScript('window.png||null'); if (!png) await new Promise((r) => setTimeout(r, 100)); }
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/icon.png'), Buffer.from(png.split(',')[1], 'base64'));
  console.log('wrote build/icon.png');
  app.quit();
});

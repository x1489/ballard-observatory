// Share: a designed "Ballard right now" image (1080×1350): the living scene rendered at full size, the temperature
// and conditions, six live stats with icons, and a footer. Share it natively (Web Share with files), download it,
// or copy it to the clipboard. Header button, or emit('share:open').
import { SUMMARY } from '../insight.js';
import { icon } from '../icons.js';

const W = 1080, H = 1350, SCENE_H = 760;

export default function init(api) {
  const u = api.util;
  const { esc, openDialog } = u;

  const svgImage = (name, color, size) => new Promise((resolve) => {
    const svg = icon(name, { size }).replace('currentColor', color).replace(/currentColor/g, color).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const font = (w, s) => `${w} ${s}px Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function fitText(c, text, maxW) { let t = String(text || ''); while (t.length > 3 && c.measureText(t).width > maxW) t = t.slice(0, -2); return t === String(text || '') ? t : `${t.trim()}…`; }

  async function renderCard() {
    const now = Date.now();
    const D = api.D;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    // background
    c.fillStyle = '#0b1020'; c.fillRect(0, 0, W, H);
    // the living scene, rendered by the hero at share size
    const scene = document.createElement('canvas');
    scene.width = W; scene.height = SCENE_H;
    const req = { canvas: scene, w: W, h: SCENE_H };
    api.emit('hero:render', req);
    if (req.done) c.drawImage(scene, 0, 0);
    const shade = c.createLinearGradient(0, 0, 0, SCENE_H);
    shade.addColorStop(0, 'rgba(0,0,0,.35)'); shade.addColorStop(0.35, 'rgba(0,0,0,0)'); shade.addColorStop(0.8, 'rgba(0,0,0,0)'); shade.addColorStop(1, 'rgba(11,16,32,1)');
    c.fillStyle = shade; c.fillRect(0, 0, W, SCENE_H);
    // headline
    const w = D('weather');
    c.fillStyle = '#fff';
    c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = 18;
    c.font = font(700, 30);
    c.fillText(`BALLARD · ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', hour: 'numeric', minute: '2-digit' }).format(now).toUpperCase()}`, 60, 88);
    if (w && w.current) {
      c.font = font(800, 190);
      c.fillText(`${Math.round(w.current.tempF)}°`, 52, 285);
      c.font = font(600, 40);
      const d0 = (w.daily || [])[0] || {};
      c.fillText(`${u.wxText(w.current.code)} · H${Math.round(d0.hiF)} L${Math.round(d0.loF)}`, 60, 345);
    }
    c.shadowBlur = 0;
    // stats grid
    const stats = ['bridge', 'bus', 'tide', 'air', 'sun', 'aircraft'].map((k) => { try { return SUMMARY[k](D, now); } catch { return null; } }).filter(Boolean).slice(0, 6);
    const gx = 50, gy = SCENE_H + 10, gw = W - 100, cols = 2, cellW = (gw - 24) / cols, cellH = 150;
    const icons = await Promise.all(stats.map((s) => svgImage(s.icon || 'sparkle', s.tone === 'warn' ? '#fdba74' : '#5eead4', 44)));
    stats.forEach((s, i) => {
      const x = gx + (i % cols) * (cellW + 24), y = gy + Math.floor(i / cols) * (cellH + 20);
      roundRect(c, x, y, cellW, cellH, 28);
      c.fillStyle = s.tone === 'warn' ? 'rgba(194,65,12,.28)' : 'rgba(255,255,255,.07)'; c.fill();
      if (icons[i]) c.drawImage(icons[i], x + 28, y + 30, 44, 44);
      c.fillStyle = 'rgba(255,255,255,.62)'; c.font = font(600, 24);
      c.fillText(fitText(c, s.label.toUpperCase(), cellW - 110), x + 90, y + 50);
      c.fillStyle = '#fff'; c.font = font(750, 46);
      c.fillText(fitText(c, s.value, cellW - 56), x + 28, y + 110);
      c.fillStyle = 'rgba(255,255,255,.62)'; c.font = font(500, 24);
      c.fillText(fitText(c, s.sub || '', cellW - 56), x + 28, y + 138);
    });
    // footer
    c.fillStyle = 'rgba(255,255,255,.5)'; c.font = font(600, 24);
    c.fillText('Ballard Live · real-time neighborhood dashboard', 60, H - 40);
    const logo = await svgImage('water', '#2dd4bf', 30);
    if (logo) c.drawImage(logo, W - 90, H - 66, 30, 30);
    return new Promise((resolve) => cv.toBlob((b) => resolve(b), 'image/png'));
  }

  async function open() {
    const blob = await renderCard();
    if (!blob) return;
    const file = new File([blob], `ballard-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.png`, { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const canShare = navigator.canShare && navigator.canShare({ files: [file] });
    const canCopy = navigator.clipboard && window.ClipboardItem;
    const d = openDialog({
      id: 'share-dlg', title: 'Share Ballard right now', wide: false,
      html: `<img class="sh-img" src="${url}" alt="Ballard right now: live conditions card">
        <div class="bl-row" style="margin-top:12px">${canShare ? `<button type="button" class="bl-btn primary" data-sh="share">${icon('share', { size: 16 })} Share…</button>` : ''}
        <a class="bl-btn${canShare ? '' : ' primary'}" href="${url}" download="${esc(file.name)}">${icon('download', { size: 16 })} Download</a>
        ${canCopy ? `<button type="button" class="bl-btn" data-sh="copy">Copy image</button>` : ''}</div>
        <p class="bl-note">Made from live data at ${u.time(Date.now())}. Nothing is uploaded; the image is generated in your browser.</p>`,
      onClose: () => setTimeout(() => URL.revokeObjectURL(url), 1000),
    });
    if (!d) return;
    d.body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-sh]');
      if (!b) return;
      try {
        if (b.dataset.sh === 'share') await navigator.share({ files: [file], title: 'Ballard right now', text: 'Live from Ballard, Seattle' });
        if (b.dataset.sh === 'copy') { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); b.textContent = 'Copied ✓'; }
      } catch { /* user cancelled or unsupported */ }
    });
  }

  api.addHeaderButton({ id: 'share-btn', html: icon('share', { size: 17 }), title: 'Share Ballard right now', onClick: open });
  api.on('share:open', open);
  const p = new URLSearchParams(location.search).get('panel');
  if (p === 'share') api.on('features', () => setTimeout(open, 1200));
}

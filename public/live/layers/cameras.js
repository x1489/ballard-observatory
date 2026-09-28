// SDOT traffic cameras as small markers (zoom 15+); tap one for its latest still image.
import { D } from './common.js';

const CAM_ICON = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#0d1319" stroke="#e6edf3" stroke-width="1.5"/><path d="M6 9h2l1.3-2h5.4L16 9h2v8H6z" fill="none" stroke="#e6edf3" stroke-width="1.5" stroke-linejoin="round"/><circle cx="12" cy="13" r="2.3" fill="#5ac8fa"/></svg>')}`;

export function createCameras() {
  let cams = [];
  const S = { visible: true };
  return {
    ingest(data) { cams = ((data && data.cameras) || []).filter((c) => c.ok && Number.isFinite(c.lat)).map((c) => ({ ...c, kind: 'camera' })); },
    produce(ctx) {
      if (!S.visible || ctx.zoom < 15 || !cams.length) return [];
      return [new (D().IconLayer)({ id: 'cameras', data: cams, pickable: true, getPosition: (d) => [d.lon, d.lat, ctx.ground(d.lon, d.lat) + 4],
        getIcon: () => ({ url: CAM_ICON, width: 48, height: 48 }), sizeUnits: 'pixels', getSize: 22, parameters: { depthCompare: 'always' } })];
    },
    get: (id) => cams.find((c) => c.id === id) || null,
    list: () => cams,
    set(o) { Object.assign(S, o); },
  };
}

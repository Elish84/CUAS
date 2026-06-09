const fs = require('fs');

const fileContent = fs.readFileSync('c:\\Users\\User\\Documents\\אלי\\CUAS\\new Radar app\\nodejs_backend\\recordings\\recording_2026-06-04_12-22-54.json', 'utf8');
const lines = fileContent.split('\n').filter(Boolean);

const kalmanInit = (lat, lng, heading, speed) => {
  const headingRad = (heading || 0) * Math.PI / 180;
  const metersPerDeg = 111320;
  const vLat = (speed * Math.cos(headingRad)) / metersPerDeg;
  const vLng = (speed * Math.sin(headingRad)) / (metersPerDeg * Math.cos(lat * Math.PI / 180) || 1);
  return {
    x: [lat, lng, vLat, vLng],
    P: [[1e-6,0,0,0],[0,1e-6,0,0],[0,0,1e-8,0],[0,0,0,1e-8]]
  };
};

const kalmanPredict = (kf, dtSec, Q) => {
    const [lat, lng, vLat, vLng] = kf.x;
    const dt = dtSec;
    const xPred = [ lat + vLat * dt, lng + vLng * dt, vLat, vLng ];
    const q = Q;
    const dt2 = dt * dt;
    const dt4o4 = dt2 * dt2 / 4;
    const P = kf.P;
    const FPFt = [
      [P[0][0] + dt*(P[2][0]+P[0][2]) + dt2*P[2][2],  P[0][1] + dt*(P[2][1]+P[0][3]) + dt2*P[2][3],  P[0][2] + dt*P[2][2],  P[0][3] + dt*P[2][3]],
      [P[1][0] + dt*(P[3][0]+P[1][2]) + dt2*P[3][2],  P[1][1] + dt*(P[3][1]+P[1][3]) + dt2*P[3][3],  P[1][2] + dt*P[3][2],  P[1][3] + dt*P[3][3]],
      [P[2][0] + dt*P[2][2],                           P[2][1] + dt*P[2][3],                           P[2][2],               P[2][3]              ],
      [P[3][0] + dt*P[3][2],                           P[3][1] + dt*P[3][3],                           P[3][2],               P[3][3]              ],
    ];
    const PPred = [
      [FPFt[0][0] + q*dt4o4, FPFt[0][1],           FPFt[0][2],      FPFt[0][3]      ],
      [FPFt[1][0],           FPFt[1][1] + q*dt4o4, FPFt[1][2],      FPFt[1][3]      ],
      [FPFt[2][0],           FPFt[2][1],           FPFt[2][2]+q*dt2, FPFt[2][3]     ],
      [FPFt[3][0],           FPFt[3][1],           FPFt[3][2],      FPFt[3][3]+q*dt2],
    ];
    return { xPred, PPred };
};

const kalmanUpdate = (xPred, PPred, measLat, measLng, R) => {
    const y0 = measLat - xPred[0];
    const y1 = measLng - xPred[1];
    const S00 = PPred[0][0] + R;
    const S01 = PPred[0][1];
    const S10 = PPred[1][0];
    const S11 = PPred[1][1] + R;
    const detS = S00 * S11 - S01 * S10;
    if (Math.abs(detS) < 1e-30) return { x: xPred, P: PPred };
    const Si00 =  S11 / detS;
    const Si01 = -S01 / detS;
    const Si10 = -S10 / detS;
    const Si11 =  S00 / detS;
    const PH = [[PPred[0][0], PPred[0][1]], [PPred[1][0], PPred[1][1]], [PPred[2][0], PPred[2][1]], [PPred[3][0], PPred[3][1]]];
    const K = PH.map(row => [row[0]*Si00 + row[1]*Si10, row[0]*Si01 + row[1]*Si11]);
    const xUpd = [
      xPred[0] + K[0][0]*y0 + K[0][1]*y1,
      xPred[1] + K[1][0]*y0 + K[1][1]*y1,
      xPred[2] + K[2][0]*y0 + K[2][1]*y1,
      xPred[3] + K[3][0]*y0 + K[3][1]*y1,
    ];
    const IKH = [
      [1 - K[0][0], -K[0][1], 0, 0],
      [-K[1][0], 1 - K[1][1], 0, 0],
      [-K[2][0], -K[2][1],    1, 0],
      [-K[3][0], -K[3][1],    0, 1],
    ];
    const PUpd = IKH.map((row) =>
      PPred[0].map((_, j) =>
        row[0]*PPred[0][j] + row[1]*PPred[1][j] + row[2]*PPred[2][j] + row[3]*PPred[3][j]
      )
    );
    return { x: xUpd, P: PUpd };
};

const fusionTracks = new Map();
let trackCounter = 0;
let maxKalmanSpeed = 0;

lines.forEach(line => {
  try {
    const entry = JSON.parse(line);
    const p = entry.packet;
    if (p && p.id && p.type !== 'imu') {
      const detection = p;
      const now = entry.timestamp;
      
      let bestTrack = null;
      for (const [, track] of fusionTracks) {
        if (track.sourceDetectionIds.includes(detection.id)) {
          bestTrack = track; break;
        }
      }
      
      if (!bestTrack) {
        trackCounter++;
        const trackId = `TRK-${String(trackCounter).padStart(4, '0')}`;
        bestTrack = {
          id: trackId,
          sourceDetectionIds: [detection.id],
          lat: detection.lat,
          lng: detection.lng,
          speed: detection.speed || 0,
          heading: detection.heading || 0,
          lastUpdated: now,
          kalman: kalmanInit(detection.lat, detection.lng, detection.heading || 0, detection.speed || 0)
        };
        fusionTracks.set(trackId, bestTrack);
      } else {
        const dtSec = (now - bestTrack.lastUpdated) / 1000;
        const { xPred, PPred } = kalmanPredict(bestTrack.kalman, dtSec, 1e-7); // Using Q = 1e-7
        const { x: xUpd, P: PUpd } = kalmanUpdate(xPred, PPred, detection.lat, detection.lng, 1e-3); // USING R = 1e-3 INSTEAD OF 1e-5
        bestTrack.kalman = { x: xUpd, P: PUpd };
        bestTrack.lastUpdated = now;
        
        const metersPerDeg = 111320;
        const vLatMs = xUpd[2] * metersPerDeg;
        const vLngMs = xUpd[3] * metersPerDeg * Math.cos(xUpd[0] * Math.PI / 180);
        const kalmanSpeed = Math.sqrt(vLatMs * vLatMs + vLngMs * vLngMs);
        if (kalmanSpeed > maxKalmanSpeed) maxKalmanSpeed = kalmanSpeed;
      }
    }
  } catch(e) {}
});
console.log('Max kalman speed with R=1e-5:', maxKalmanSpeed);

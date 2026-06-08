const express = require('express');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// Serve static assets from the frontend/dist folder
app.use(express.static(path.join(__dirname, '..', 'frontend', 'dist')));

// Recording variables
let isRecording = false;
let currentRecordingFile = null;
let recordingFilePath = null;
let recordingStartTime = 0;
let recordingTimeout = null;
let maxRecordingDurationMin = 10;

// Create recordings directory if not exists
const recordingsDir = path.join(__dirname, 'recordings');
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir);
}

// Get all recording files
app.get('/api/recordings', (req, res) => {
  fs.readdir(recordingsDir, (err, files) => {
    if (err) return res.status(500).json({ error: 'Failed to read recordings directory' });
    try {
      const recordings = files
        .filter(file => file.endsWith('.json'))
        .map(file => {
          const filePath = path.join(recordingsDir, file);
          const stats = fs.statSync(filePath);
          return {
            filename: file,
            size: stats.size,
            createdAt: stats.mtime
          };
        })
        .sort((a, b) => b.createdAt - a.createdAt);
      res.json(recordings);
    } catch (e) {
      res.status(500).json({ error: 'Error listing files: ' + e.message });
    }
  });
});

// Download a specific recording file
app.get('/api/recordings/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(recordingsDir, path.basename(filename));
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.sendFile(filePath);
});

// Download a recording file with offline fusion applied inline
app.get('/api/recordings/download_fused/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(recordingsDir, path.basename(filename));
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const lines = fileContent.split('\n').filter(Boolean);
  const offlineFusionEngine = createFusionEngine();
  
  const outputLines = [];
  
  lines.forEach(line => {
    outputLines.push(line); // original detection/imu packet
    
    try {
      const entry = JSON.parse(line);
      const p = entry.packet;
      if (p && p.id && p.type !== 'imu') {
        // Run fusion and collect emitted tracks
        offlineFusionEngine.fuseDetection(p, (track) => {
          outputLines.push(JSON.stringify({ 
            timestamp: entry.timestamp, 
            packet: { type: 'track', ...track } 
          }));
        });
      }
    } catch(e) {
      // Ignore parse errors on corrupted lines
    }
  });

  res.send(outputLines.join('\n') + '\n');
});

// Start recording
app.post('/api/recordings/start', (req, res) => {
  if (isRecording) {
    return res.status(400).json({ error: 'Already recording' });
  }

  const maxDuration = parseInt(req.body.maxDuration, 10) || 10;
  maxRecordingDurationMin = maxDuration;

  const date = new Date();
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}_${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}-${String(date.getSeconds()).padStart(2, '0')}`;
  const filename = `recording_${dateStr}.json`;
  recordingFilePath = path.join(recordingsDir, filename);

  try {
    currentRecordingFile = fs.createWriteStream(recordingFilePath, { flags: 'a' });
    isRecording = true;
    recordingStartTime = Date.now();

    // Auto-stop timeout
    if (recordingTimeout) clearTimeout(recordingTimeout);
    recordingTimeout = setTimeout(() => {
      if (isRecording) {
        stopRecording();
        sendToFrontend({ type: 'recordingStatus', state: 'stopped', autoStopped: true });
      }
    }, maxRecordingDurationMin * 60 * 1000);

    console.log(`Started recording to ${filename}`);
    res.json({ success: true, filename });
    sendToFrontend({ type: 'recordingStatus', state: 'recording', filename });
  } catch (e) {
    res.status(500).json({ error: 'Failed to start recording: ' + e.message });
  }
});

// Helper to stop recording
function stopRecording() {
  if (recordingTimeout) {
    clearTimeout(recordingTimeout);
    recordingTimeout = null;
  }
  if (isRecording && currentRecordingFile) {
    currentRecordingFile.end();
    currentRecordingFile = null;
    isRecording = false;
    console.log('Recording stopped.');
    return true;
  }
  return false;
}

// Stop recording
app.post('/api/recordings/stop', (req, res) => {
  if (!isRecording) {
    return res.status(400).json({ error: 'Not recording' });
  }
  const originalFilename = path.basename(recordingFilePath);
  stopRecording();
  res.json({ success: true, filename: originalFilename });
  sendToFrontend({ type: 'recordingStatus', state: 'stopped' });
});

// Rename recording file
app.post('/api/recordings/rename', (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName) {
    return res.status(400).json({ error: 'Missing filenames' });
  }
  const cleanOld = path.basename(oldName);
  let cleanNew = path.basename(newName);
  if (!cleanNew.endsWith('.json')) cleanNew += '.json';

  const oldPath = path.join(recordingsDir, cleanOld);
  const newPath = path.join(recordingsDir, cleanNew);

  if (!fs.existsSync(oldPath)) {
    return res.status(404).json({ error: 'Original file not found' });
  }
  if (fs.existsSync(newPath)) {
    return res.status(400).json({ error: 'Target filename already exists' });
  }

  try {
    fs.renameSync(oldPath, newPath);
    res.json({ success: true, newName: cleanNew });
  } catch (e) {
    res.status(500).json({ error: 'Failed to rename file: ' + e.message });
  }
});

// Delete recording file
app.delete('/api/recordings/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(recordingsDir, path.basename(filename));
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete file: ' + e.message });
  }
});

// Helper to record telemetry to active file
function recordTelemetry(packet) {
  if (isRecording && currentRecordingFile) {
    const recordObj = {
      timestamp: Date.now() - recordingStartTime,
      packet
    };
    currentRecordingFile.write(JSON.stringify(recordObj) + '\n');
  }
}

// Serve index.html on all requests (for single page routing if necessary)
app.get('{*any}', (req, res, next) => {
  // If the request is for API or WS handshake, let it pass
  if (req.headers.upgrade === 'websocket' || req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
});

const server = app.listen(8080, () => {
  console.log('MITZPE METZODA listening on http://localhost:8080');
});

const wss = new WebSocket.Server({ server });

let radars = {}; // map of radarId -> radar config
let daemonProcesses = {}; // map of radarId -> child_process
let liveImuData = {}; // map of radarId -> { pitch, roll, yaw }
let activeWs = null; // track the currently active frontend WebSocket

// ─────────────────────────────────────────────────────────────
//  FUSION ENGINE — Motion-Aided Detection-to-Track Association
// ─────────────────────────────────────────────────────────────

let fusionConfig = {
  maxAssocDistM: 150,        // max positional gate (meters, after kinematic prediction)
  maxAssocTimeSec: 10,       // max seconds a track lives without an update
  minDetectionsToConfirm: 2, // N-of-M confirmation before track is broadcast
  classificationFusionMode: 'max_prob', // 'max_prob' | 'majority' | 'latest'
  crossRadarFusion: true,    // fuse detections from different radars
  maxHeadingDiffDeg: 60,     // max heading difference gate (degrees)
  maxSpeedRatioFactor: 2.5,  // max speed ratio (faster/slower must be <= this)
  wPosition: 0.6,            // weight of position component in combined cost
  wVelocity: 0.4,            // weight of velocity component in combined cost
  kalmanQ: 1e-7,             // process noise variance (lower = smoother, slower to adapt)
  kalmanR: 2e-8,             // measurement noise variance (lower = trust measurement more)
};

function createFusionEngine() {
  const fusionTracks = new Map(); // trackId -> FusedTrack
  let trackCounter = 0;

  // ─── Kalman Filter helpers ────────────────────────────────────────────────────
  function kalmanInit(lat, lng, heading, speed) {
    const headingRad = (heading || 0) * Math.PI / 180;
    const metersPerDeg = 111320;
    const vLat = (speed * Math.cos(headingRad)) / metersPerDeg;
    const vLng = (speed * Math.sin(headingRad)) / (metersPerDeg * Math.cos(lat * Math.PI / 180) || 1);
    return {
      x: [lat, lng, vLat, vLng],   // state
      P: [                          // covariance (diagonal, large init uncertainty)
        [1e-6, 0,    0,     0    ],
        [0,    1e-6, 0,     0    ],
        [0,    0,    1e-8,  0    ],
        [0,    0,    0,     1e-8 ],
      ]
    };
  }

  function kalmanPredict(kf, dtSec, Q) {
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
  }

  function kalmanUpdate(xPred, PPred, measLat, measLng, R) {
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
  }

  function haversineDist(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function headingDiff(h1, h2) {
    let diff = Math.abs((h1 - h2 + 360) % 360);
    if (diff > 180) diff = 360 - diff;
    return diff;
  }

  function predictPosition(track, dtSec) {
    const headingRad = (track.heading || 0) * Math.PI / 180;
    const speed = track.speed || 0;
    const vx = speed * Math.sin(headingRad);
    const vy = speed * Math.cos(headingRad);
    const metersPerLat = 111320;
    const metersPerLng = 111320 * Math.cos((track.lat || 0) * Math.PI / 180);
    return {
      lat: track.lat + (vy * dtSec) / metersPerLat,
      lng: track.lng + (vx * dtSec) / metersPerLng
    };
  }

  function mergeProbUAV(track, detection, mode) {
    const newProb = detection.probUAV !== undefined ? detection.probUAV :
      (detection.classification === 'drone' ? 1.0 : detection.classification === 'bird' ? 0.05 : 0.5);
    if (mode === 'max_prob') return Math.max(track.probUAV, newProb);
    else if (mode === 'latest') return newProb;
    else return 0.6 * track.probUAV + 0.4 * newProb;
  }

  return {
    fuseDetection: (detection, emitTrackFn) => {
      const now = detection.lastUpdated || Date.now();
      const cfg = fusionConfig;

      let bestTrack = null;
      let bestCost = Infinity;

      // 0. Hard ID match: If an active track is already tracking this exact radar detection ID,
      // associate immediately. The radar's own ID continuity is highly reliable.
      for (const [, track] of fusionTracks) {
        if (track.sourceDetectionIds.includes(detection.id)) {
          const dtSec = (now - track.lastUpdated) / 1000;
          if (dtSec <= cfg.maxAssocTimeSec) {
            bestTrack = track;
            bestCost = 0;
            break;
          }
        }
      }

      if (!bestTrack) {
        for (const [, track] of fusionTracks) {
        const dtSec = (now - track.lastUpdated) / 1000;
        if (dtSec > cfg.maxAssocTimeSec) continue;

        if (!cfg.crossRadarFusion && detection.radarId !== track.primaryRadarId) continue;

        const predicted = predictPosition(track, dtSec);
        const distToPredicted = haversineDist(detection.lat, detection.lng, predicted.lat, predicted.lng);
        const distToLastKnown = haversineDist(detection.lat, detection.lng, track.lat, track.lng);

        const detSpeed = detection.speed || 0;
        const trkSpeed = track.speed || 0;
        
        let hDiff = 0;
        if (detSpeed >= 1 && trkSpeed >= 1) {
          hDiff = headingDiff(detection.heading || 0, track.heading || 0);
        }
        
        let ratio = 1;
        if (detSpeed >= 1 && trkSpeed >= 1) {
          ratio = Math.max(detSpeed, trkSpeed) / Math.min(detSpeed, trkSpeed);
        }

        const passesKinematic = (distToPredicted <= cfg.maxAssocDistM) && 
                                (hDiff <= cfg.maxHeadingDiffDeg) && 
                                (ratio <= cfg.maxSpeedRatioFactor);

        // Fallback: If kinematic prediction fails due to sharp maneuvers/turns, check if it's very close to last known position.
        const passesFallback = (distToLastKnown <= cfg.maxAssocDistM);

        if (!passesKinematic && !passesFallback) continue;

        let totalCost;
        if (passesKinematic) {
          const positionCost = distToPredicted / cfg.maxAssocDistM;
          const headingCost = hDiff / cfg.maxHeadingDiffDeg;
          const speedCost = (detSpeed >= 1 && trkSpeed >= 1) ? Math.abs(detSpeed - trkSpeed) / Math.max(detSpeed, trkSpeed, 1) : 0;
          const velocityCost = 0.6 * headingCost + 0.4 * speedCost;
          totalCost = cfg.wPosition * positionCost + cfg.wVelocity * velocityCost;
        } else {
          // Fallback cost: heavily penalize so that true kinematic matches always win if they exist, 
          // but allow association if no better track is found.
          totalCost = 1.0 + (distToLastKnown / cfg.maxAssocDistM);
        }

        if (totalCost < bestCost) {
          bestCost = totalCost;
          bestTrack = track;
        }
      }
      }

      if (bestTrack) {
        const dtSec = (now - bestTrack.lastUpdated) / 1000;
        const { xPred, PPred } = kalmanPredict(bestTrack.kalman, dtSec, cfg.kalmanQ);

        // --- Outlier Rejection (Multipath Glitch Protection) ---
        const dLat = detection.lat - bestTrack.lat;
        const dLng = (detection.lng - bestTrack.lng) * Math.cos(bestTrack.lat * Math.PI / 180);
        const mPerDeg = 111320;
        const jumpDistanceM = Math.sqrt(dLat*dLat + dLng*dLng) * mPerDeg;
        const requiredSpeed = dtSec > 0 ? jumpDistanceM / dtSec : 0;
        const reportedSpeed = detection.speed || 0;
        
        // If the target jumped more than 50m, requiring a speed > 100m/s, but radar reports low doppler speed:
        const isGlitch = jumpDistanceM > 50 && requiredSpeed > 100 && requiredSpeed > reportedSpeed * 5;

        let xUpd, PUpd;
        if (isGlitch) {
          // Ignore the glitchy coordinates, just use the Kalman prediction
          xUpd = xPred;
          PUpd = PPred;
        } else {
          const res = kalmanUpdate(xPred, PPred, detection.lat, detection.lng, cfg.kalmanR);
          xUpd = res.x;
          PUpd = res.P;
        }

        bestTrack.kalman = { x: xUpd, P: PUpd };
        bestTrack.lat = xUpd[0];
        bestTrack.lng = xUpd[1];

        const metersPerDeg = 111320;
        const vLatMs = xUpd[2] * metersPerDeg;
        const vLngMs = xUpd[3] * metersPerDeg * Math.cos(xUpd[0] * Math.PI / 180);
        const kalmanSpeed = Math.sqrt(vLatMs * vLatMs + vLngMs * vLngMs);
        const kalmanHeading = (Math.atan2(vLngMs, vLatMs) * 180 / Math.PI + 360) % 360;

        if (kalmanSpeed >= 0.5) {
          bestTrack.speed   = 0.7 * kalmanSpeed + 0.3 * (detection.speed || 0);
          bestTrack.heading = kalmanSpeed > 1 ? kalmanHeading : (detection.heading || bestTrack.heading);
        } else {
          bestTrack.speed   = detection.speed || bestTrack.speed;
          bestTrack.heading = detection.heading !== undefined ? detection.heading : bestTrack.heading;
        }

        bestTrack.alt = 0.6 * (detection.alt || bestTrack.alt) + 0.4 * bestTrack.alt;
        bestTrack.probUAV = mergeProbUAV(bestTrack, detection, cfg.classificationFusionMode);
        bestTrack.classification = bestTrack.probUAV > 0.5 ? 'drone' : (bestTrack.probUAV < 0.15 ? 'bird' : 'unknown');
        bestTrack.confidence = detection.confidence || bestTrack.confidence;
        bestTrack.lastUpdated = now;
        bestTrack.detectionCount += 1;
        if (!bestTrack.sourceDetectionIds.includes(detection.id)) {
          bestTrack.sourceDetectionIds.push(detection.id);
        }
        if (!bestTrack.radarIds.includes(detection.radarId)) {
          bestTrack.radarIds.push(detection.radarId);
        }
        bestTrack.historyHeading = bestTrack.historyHeading || [];
        bestTrack.historySpeed = bestTrack.historySpeed || [];
        bestTrack.historyHeading.push(kalmanHeading);
        bestTrack.historySpeed.push(kalmanSpeed);
        if (bestTrack.historyHeading.length > 30) bestTrack.historyHeading.shift();
        if (bestTrack.historySpeed.length > 30) bestTrack.historySpeed.shift();

        // Kinematic Classification Heuristic
        if (bestTrack.historySpeed.length >= 20) {
           const avgS = bestTrack.historySpeed.reduce((a,b)=>a+b,0)/bestTrack.historySpeed.length;
           const varS = bestTrack.historySpeed.reduce((a,b)=>a+Math.pow(b-avgS,2),0)/bestTrack.historySpeed.length;
           const stdS = Math.sqrt(varS);
           const rcs = (bestTrack.raw && bestTrack.raw.rcs !== undefined) ? bestTrack.raw.rcs : -999;
           
           // If target maintains steady high speed and has drone-like RCS, boost its probability.
           if (avgS >= 8 && stdS <= 3.5 && rcs >= -18) {
               bestTrack.probUAV = Math.max(bestTrack.probUAV, 0.6); // Override to drone
           }
        }

        bestTrack.classification = bestTrack.probUAV > 0.5 ? 'drone' : (bestTrack.probUAV < 0.15 ? 'bird' : 'unknown');
        bestTrack.raw = detection.raw || bestTrack.raw;

        if (!bestTrack.isConfirmed && bestTrack.detectionCount >= cfg.minDetectionsToConfirm) {
          bestTrack.isConfirmed = true;
          // console.log(`[Fusion] Track ${bestTrack.id} CONFIRMED (${bestTrack.detectionCount} detections)`);
        }

        if (bestTrack.isConfirmed) {
          emitTrackFn({ type: 'track', ...bestTrack, kalman: undefined });
        }
      } else {
        trackCounter += 1;
        const trackId = `TRK-${String(trackCounter).padStart(4, '0')}`;
        const initProb = detection.probUAV !== undefined ? detection.probUAV :
          (detection.classification === 'drone' ? 1.0 : detection.classification === 'bird' ? 0.05 : 0.5);
        const newTrack = {
          id: trackId,
          primaryRadarId: detection.radarId,
          radarIds: [detection.radarId],
          sourceDetectionIds: [detection.id],
          lat: detection.lat,
          lng: detection.lng,
          alt: detection.alt || 0,
          speed: detection.speed || 0,
          heading: detection.heading || 0,
          classification: detection.classification || 'unknown',
          probUAV: initProb,
          confidence: detection.confidence || 0,
          lastUpdated: now,
          firstSeen: now,
          detectionCount: 1,
          isConfirmed: false,
          raw: detection.raw,
          historyHeading: [detection.heading || 0],
          historySpeed: [detection.speed || 0],
          kalman: kalmanInit(detection.lat, detection.lng, detection.heading || 0, detection.speed || 0),
        };
        fusionTracks.set(trackId, newTrack);
      }
    },
    cleanup: (now) => {
      const cfg = fusionConfig;
      for (const [trackId, track] of fusionTracks) {
        if ((now - track.lastUpdated) / 1000 > cfg.maxAssocTimeSec) {
          fusionTracks.delete(trackId);
        }
      }
    }
  };
}

// Live engine instance
const liveFusionEngine = createFusionEngine();

setInterval(() => {
  liveFusionEngine.cleanup(Date.now());
}, 2000);

// Safely send a message to the current active frontend WebSocket
function sendToFrontend(data) {
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify(data));
  }
}

// ── Fusion config API endpoints ──────────────────────────────
app.get('/api/fusion/config', (req, res) => {
  res.json(fusionConfig);
});

app.post('/api/fusion/config', (req, res) => {
  const allowed = [
    'maxAssocDistM', 'maxAssocTimeSec', 'minDetectionsToConfirm',
    'classificationFusionMode', 'crossRadarFusion',
    'maxHeadingDiffDeg', 'maxSpeedRatioFactor', 'wPosition', 'wVelocity',
    'kalmanQ', 'kalmanR'
  ];
  allowed.forEach(key => {
    if (req.body[key] !== undefined) {
      fusionConfig[key] = req.body[key];
    }
  });
  console.log('[Fusion] Config updated:', fusionConfig);
  res.json({ success: true, config: fusionConfig });
});

const net = require('net');

function configureAndStartRadar(radar, callback) {
  const client = new net.Socket();
  
  const rangeVal = radar.maxRange || 2000;
  const startBin = Math.floor(rangeVal / 3.25) + 128;
  
  const commands = [
    "MODE:SWT:STOP",
    `DMS:CHANNEL ${radar.freqChannel || 1}`,
    `MODE:SWT:SEARCH:ELFOVMIN ${radar.elFovMin ?? -40}`,
    `MODE:SWT:SEARCH:ELFOVMAX ${radar.elFovMax ?? 40}`,
    `MODE:SWT:SEARCH:AZFOVMIN ${radar.azFovMin ?? -60}`,
    `MODE:SWT:SEARCH:AZFOVMAX ${radar.azFovMax ?? 60}`,
    `RSP:RCSMASK:MINRCS ${radar.minRcs ?? -30}`,
    `RSP:RCSMASK:MAXRCS ${radar.maxRcs ?? 10}`,
    `RSP:CLUTTERMASKWIDTH eldorado ${radar.clutterWidth || 3}`,
    "RANGE:MASK eldorado 0,128,134,0,31",
    `RANGE:MASK eldorado 1,${startBin},2047,0,31`,
    "MODE:SWT:START"
  ];

  client.connect(radar.port || 23, radar.ip, () => {
    console.log(`[TCP Config] Connected to ${radar.ip}:${radar.port || 23}`);
    let i = 0;
    function sendNext() {
      if (i < commands.length) {
        console.log(`[TCP Config] Sending: ${commands[i]}`);
        client.write(commands[i] + "\r\n");
        i++;
        setTimeout(sendNext, 60);
      } else {
        setTimeout(() => {
          client.destroy();
        }, 100);
      }
    }
    setTimeout(sendNext, 300);
  });

  client.on('error', (err) => {
    console.error(`[TCP Config] Error: ${err.message}`);
    client.destroy();
  });

  client.on('close', () => {
    console.log(`[TCP Config] Connection closed for ${radar.ip}. Spawning daemon...`);
    callback();
  });
}

function spawnDaemon(radar) {
  if (daemonProcesses[radar.id]) {
    console.log(`Daemon for radar ${radar.id} already running.`);
    // Daemon already connected - send status to new frontend ws
    sendToFrontend({ type: 'status', radarId: radar.id, state: 'connected', message: `Radar ${radar.id} daemon already running` });
    return;
  }

  configureAndStartRadar(radar, () => {
    console.log(`Spawning daemon for Radar ${radar.id} at ${radar.ip}:${radar.port || 23}...`);
    const exePath = path.join(__dirname, 'build', 'radar_daemon.exe');
    
    try {
      if (!fs.existsSync('C:\\temp')) {
        fs.mkdirSync('C:\\temp', { recursive: true });
      }
    } catch (e) {
      console.error('Failed to create C:\\temp:', e.message);
    }

    const child = spawn(exePath, [
      radar.ip, 
      (radar.port || 23).toString(), 
      radar.id.toString(),
      (radar.freqChannel || 1).toString(),
      (radar.elFovMin ?? -40).toString(),
      (radar.elFovMax ?? 40).toString(),
      (radar.azFovMin ?? -60).toString(),
      (radar.azFovMax ?? 60).toString(),
      (radar.minRcs ?? -30).toString(),
      (radar.maxRcs ?? 10).toString(),
      (radar.maxRange || 2000).toString(),
      (radar.clutterWidth || 3).toString()
    ], {
      cwd: 'C:\\temp'
    });
  
  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line.trim());
        if (msg.type === 'track') {
          // Convert daemon track coordinates to lat/lng detection
          const radarConfig = radars[msg.radarId] || radar;
          
          // Get Pitch and Roll from live IMU if enabled, otherwise from config
          const liveImu = liveImuData[msg.radarId];
          const useImu = radarConfig.useImu === true;
          
          let pitch = 0;
          let roll = 0;
          if (useImu && liveImu) {
            pitch = liveImu.pitch;
            roll = liveImu.roll;
          } else {
            pitch = radarConfig.pitch || 0;
            roll = radarConfig.roll || 0;
          }
          
          const heading = radarConfig.heading || 0;
          
          const r = msg.rest !== undefined ? msg.rest : Math.sqrt(msg.x*msg.x + msg.y*msg.y + msg.z*msg.z);
          const azRel = msg.azest !== undefined ? (msg.azest * Math.PI / 180) : ((msg.x === 0 && msg.z === 0) ? 0 : Math.atan2(msg.x, msg.z));
          const elRel = msg.elest !== undefined ? (msg.elest * Math.PI / 180) : (r === 0 ? 0 : Math.asin(msg.y / r));

          // 3D Rotation Matrix compensation:
          // X is Right, Y is Up, Z is Forward
          const x_local = -msg.x;
          const y_local = msg.y;
          const z_local = msg.z;

          // 1. Roll rotation around Z (Forward):
          const rollRad = roll * (Math.PI / 180);
          const cosR = Math.cos(rollRad);
          const sinR = Math.sin(rollRad);
          const x1 = x_local * cosR + y_local * sinR;
          const y1 = -x_local * sinR + y_local * cosR;
          const z1 = z_local;

          // 2. Pitch rotation around X (Right):
          const pitchRad = pitch * (Math.PI / 180);
          const cosP = Math.cos(pitchRad);
          const sinP = Math.sin(pitchRad);
          const x2 = x1;
          const y2 = y1 * cosP + z1 * sinP;
          const z2 = -y1 * sinP + z1 * cosP;

          // 3. Heading (Yaw) rotation around vertical axis to map to East, North, Up:
          const headingRad = heading * (Math.PI / 180);
          const cosH = Math.cos(headingRad);
          const sinH = Math.sin(headingRad);
          
          const dEast = z2 * sinH + x2 * cosH;
          const dNorth = z2 * cosH - x2 * sinH;
          const dz = y2;

          // Calculate true global azimuth and elevation
          const trueAzRad = Math.atan2(dEast, dNorth);
          const trueElRad = Math.asin(dz / Math.sqrt(dEast*dEast + dNorth*dNorth + dz*dz || 1));

          // Convert meters to lat/lng degrees
          const metersPerLat = 111320;
          const metersPerLng = 111320 * Math.cos(radarConfig.homeLocation[0] * (Math.PI / 180));
          const latOffset = dNorth / metersPerLat;
          const lngOffset = dEast / metersPerLng;

          const detection = {
            id: `${msg.radarId}-${msg.id}`,
            radarId: parseInt(msg.radarId, 10),
            lat: radarConfig.homeLocation[0] + latOffset, 
            lng: radarConfig.homeLocation[1] + lngOffset,
            alt: radarConfig.homeLocation[2] + dz,
            type: msg.probUAV > 0.5 ? 'drone' : 'unknown',
            probUAV: msg.probUAV,
            speed: Math.sqrt(msg.speedX**2 + msg.speedY**2 + msg.speedZ**2),
            heading: Math.atan2(msg.speedY, msg.speedX) * (180 / Math.PI), // Note: relative heading, may also need rotation in future
            confidence: msg.confidence,
            lastUpdated: Date.now(),
            raw: { 
              ...msg,
              range_m: parseFloat(r.toFixed(2)),
              relativeAzimuth_deg: parseFloat((azRel * 180 / Math.PI).toFixed(2)),
              relativeElevation_deg: parseFloat((elRel * 180 / Math.PI).toFixed(2)),
              trueAzimuth_deg: parseFloat((trueAzRad * 180 / Math.PI).toFixed(2)),
              trueElevation_deg: parseFloat((trueElRad * 180 / Math.PI).toFixed(2))
            }
          };
          recordTelemetry(detection);
          sendToFrontend(detection);
          liveFusionEngine.fuseDetection(detection, sendToFrontend);
        } else if (msg.type === 'imu') {
          const qx = msg.quat_x;
          const qy = msg.quat_y;
          const qz = msg.quat_z;
          const qw = msg.quat_w;
          
          // Quaternion to Euler conversion (pitch/roll/yaw)
          const rollRad = Math.atan2(2 * (qw * qx + qy * qz), 1 - 2 * (qx * qx + qy * qy));
          const sinp = 2 * (qw * qy - qz * qx);
          const pitchRad = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp);
          const yawRad = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));

          const rawPitch = rollRad * (180 / Math.PI);
          const pitch = (rawPitch - 90) * -1;
          const roll = pitchRad * (180 / Math.PI);
          const yaw = yawRad * (180 / Math.PI);

          liveImuData[msg.radarId] = {
            pitch: pitch,
            roll: roll,
            yaw: yaw
          };

          const imuPayload = {
            type: 'imu',
            radarId: parseInt(msg.radarId, 10),
            pitch: parseFloat(pitch.toFixed(2)),
            roll: parseFloat(roll.toFixed(2)),
            yaw: parseFloat(yaw.toFixed(2))
          };
          recordTelemetry(imuPayload);
          sendToFrontend(imuPayload);
        } else if (msg.type === 'status') {
          console.log(`[Daemon ${msg.radarId}] STATUS: ${msg.message}`);
          // Daemon successfully connected to radar - send 'connected' state
          sendToFrontend({ type: 'status', radarId: parseInt(msg.radarId, 10), state: 'connected', message: msg.message });
        } else if (msg.type === 'error') {
          console.error(`[Daemon ${msg.radarId}] ERROR: ${msg.message}`);
          sendToFrontend({ type: 'error', radarId: parseInt(msg.radarId, 10), message: msg.message });
        } else {
          console.log(`[Daemon ${msg.radarId}]: ${msg.message || JSON.stringify(msg)}`);
        }
      } catch (e) {
        // Not JSON, just standard output logging
        console.log(`[Daemon Raw]: ${line.trim()}`);
      }
    });
  });

  child.stderr.on('data', (data) => {
    const text = data.toString().trim();
    console.error(`[Daemon ${radar.id} Error]: ${text}`);
    // Forward stderr as error to frontend
    sendToFrontend({ type: 'error', radarId: radar.id, message: text });
  });

  child.on('close', (code) => {
    console.log(`Daemon for radar ${radar.id} exited with code ${code}`);
    delete daemonProcesses[radar.id];
    sendToFrontend({ type: 'error', radarId: radar.id, message: `Daemon exited (code ${code})` });
  });

  daemonProcesses[radar.id] = child;
  });
}

function killDaemon(radarId) {
  const child = daemonProcesses[radarId];
  if (child) {
    try {
      child.stdin.write("CMD:TURN_OFF\n");
      child.stdin.write("CMD:EXIT\n");
    } catch(e) {}
    setTimeout(() => {
      try { child.kill(); } catch(e) {}
    }, 2000);
    delete daemonProcesses[radarId];
  }
}

wss.on('connection', (ws) => {
  console.log('Frontend React App connected to WebSocket');
  activeWs = ws;

  // Send current status of all running daemons to newly connected frontend
  Object.keys(daemonProcesses).forEach(radarId => {
    ws.send(JSON.stringify({ type: 'status', radarId: parseInt(radarId, 10), state: 'connected', message: `Radar ${radarId} daemon running` }));
  });
  
  ws.on('message', (message) => {
    try {
      const command = JSON.parse(message);
      
      if (command.action === 'configure') {
        // Store ALL radars by ID for later per-radar commands
        if (Array.isArray(command.radars)) {
          command.radars.forEach(r => { radars[r.id] = r; });
          console.log('Configured', Object.keys(radars).length, 'radars.');
        }
      } else if (command.action === 'turnOn') {
        const targets = command.radarId
          ? [radars[command.radarId]].filter(Boolean)
          : Object.values(radars);
        
        targets.forEach(radar => {
          console.log(`Turning ON radar ${radar.id} at ${radar.ip}`);
          sendToFrontend({ type: 'status', radarId: radar.id, state: 'connecting', message: `Connecting to radar ${radar.id}...` });
          spawnDaemon(radar);
          // If daemon was already running, spawnDaemon already sent 'connected'
          // If daemon is new, it will send stdout 'status' when connected
          if (daemonProcesses[radar.id]) {
            daemonProcesses[radar.id].stdin.write("CMD:TURN_ON\n");
          }
        });
      } else if (command.action === 'turnOff') {
        const targets = command.radarId
          ? [radars[command.radarId]].filter(Boolean)
          : Object.values(radars);

        targets.forEach(radar => {
          console.log(`Turning OFF radar ${radar.id}`);
          killDaemon(radar.id);
          sendToFrontend({ type: 'status', radarId: radar.id, state: 'off', message: `Radar ${radar.id} turned off` });
        });
      }
    } catch(e) {
      console.error('Error processing message:', e);
    }
  });

  ws.on('close', () => {
    console.log('Frontend disconnected.');
    if (activeWs === ws) {
      activeWs = null;
    }
    // Don't kill daemons on disconnect - they may still be collecting data
    // They will reconnect when a new frontend connects
  });
});

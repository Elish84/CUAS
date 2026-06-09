import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Map, { Source, Layer, Marker, NavigationControl } from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Power, Crosshair, MapPin, Activity, Settings, Radar, Sliders, Wifi, WifiOff, Filter, List, Focus, Trash2, ShieldAlert, Check, Play, Pause, Square, Circle } from 'lucide-react';
import * as turf from '@turf/turf';
import './index.css';

type SimTrack = {
  id: string;
  radarId: number;
  lat: number;
  lng: number;
  alt: number;
  heading: number;
  speed: number;
  classification: 'drone' | 'bird';
  confidence: number;
  createdAt: number;
  ttl: number;
  probUAV?: number;
};


// Types
type RadarConfig = {
  id: number;
  name?: string;
  ip: string;
  isActive: boolean;
  homeLocation: [number, number, number]; // [lat, lng, alt ASL] -> note turf uses [lng, lat]
  heading: number;
  elevation: number; 
  pitch: number;
  roll: number;
  useImu?: boolean;
  fadeThreshold: number; 
  freqChannel: number;
  elFovMin: number;
  elFovMax: number;
  azFovMin: number;
  azFovMax: number;
  minRcs: number;
  maxRcs: number;
  maxRange: number; // meters
  clutterWidth?: number;
};

type Detection = {
  id: string;
  lat: number;
  lng: number;
  alt: number; // ASL
  classification: 'drone' | 'unknown' | 'bird';
  confidence: number;
  speed: number;
  heading: number;
  lastUpdated: number; 
  radarId: number; 
  probUAV?: number;
  raw?: any;
};

type FusedTrack = {
  id: string;               // stable TRK-NNNN identifier
  radarIds: number[];       // all radars that contributed
  lat: number;
  lng: number;
  alt: number;
  speed: number;
  heading: number;
  classification: 'drone' | 'unknown' | 'bird';
  probUAV: number;
  confidence: number;
  lastUpdated: number;
  firstSeen: number;
  detectionCount: number;
  isConfirmed: boolean;
  raw?: any;
};

type DisplayMode = 'detections' | 'tracks' | 'both';

type MapFilters = {
  showDrone: boolean;
  showUnknown: boolean;
  showBird: boolean;
  minSpeed: number;
  maxSpeed: number;
  minAgl: number;
  maxAgl: number;
  trailLengthSeconds: number;
  minRcs: number;
  maxRcs: number;
};

type IgnoreZone = {
  id: string;
  name: string;
  type: 'circle' | 'polygon';
  coordinates: [number, number][]; 
  radius?: number; 
  minAgl: number;
  maxAgl: number;
};

type DefenseZone = {
  id: string;
  name: string;
  coordinates: [number, number][];  // closed polygon ring [lng, lat]
  color: string;
};

type ThreatWeights = {
  wClass: number;   // weight for classification score
  wProx:  number;   // weight for proximity score
  wEta:   number;   // weight for ETA score
  rDanger: number;  // danger radius in meters (S_prox reaches 0 at this distance)
  tDanger: number;  // danger ETA threshold in seconds (S_eta reaches 0 at this time)
};

// ─────────────────────────────────────────────────────────────
//  THREAT SCORE ENGINE
// ─────────────────────────────────────────────────────────────

/**
 * Nearest distance (m) from a point to a polygon boundary.
 * Returns negative if point is INSIDE the polygon.
 */
function distToDefenseZone(lng: number, lat: number, zone: DefenseZone): number {
  const pt = turf.point([lng, lat]);
  const poly = turf.polygon([zone.coordinates]);
  const inside = turf.booleanPointInPolygon(pt, poly);
  if (inside) return -1;
  // Measure to each segment and take minimum
  const ring = zone.coordinates;
  let minDist = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const seg = turf.lineString([ring[i], ring[i + 1]]);
    const d = turf.pointToLineDistance(pt, seg, { units: 'meters' });
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/**
 * Bearing from (lng1,lat1) to the nearest point on a zone boundary (degrees, 0=N).
 */
function bearingToZone(lng: number, lat: number, zone: DefenseZone): number {
  const pt = turf.point([lng, lat]);
  const ring = zone.coordinates;
  let minDist = Infinity;
  let nearestPt = ring[0];
  for (let i = 0; i < ring.length - 1; i++) {
    const seg = turf.lineString([ring[i], ring[i + 1]]);
    const snapped = turf.nearestPointOnLine(seg, pt);
    const d = turf.distance(pt, snapped, { units: 'meters' });
    if (d < minDist) { minDist = d; nearestPt = snapped.geometry.coordinates as [number, number]; }
  }
  return turf.bearing(pt, turf.point(nearestPt));
}

/**
 * Main threat score computation.
 * Returns a score in [0, 1] and the three sub-scores.
 */
function computeThreatScore(
  d: { lng: number; lat: number; speed: number; heading: number; probUAV?: number; classification: string },
  defenseZones: DefenseZone[],
  w: ThreatWeights
): { score: number; sClass: number; sProx: number; sEta: number; distM: number; etaSec: number } {

  // ── S_class ─────────────────────────────────────────────
  let sClass: number;
  if (d.probUAV !== undefined) {
    sClass = d.probUAV;
  } else {
    sClass = d.classification === 'drone' ? 1.0
           : d.classification === 'bird'  ? 0.05
           : 0.5;
  }

  // ── Find nearest defense zone ────────────────────────────
  let distM = Infinity;
  let nearestZone: DefenseZone | null = null;
  for (const zone of defenseZones) {
    const d2 = distToDefenseZone(d.lng, d.lat, zone);
    if (d2 < distM) { distM = d2; nearestZone = zone; }
  }

  let sProx = 0;
  let sEta  = 0;
  let etaSec = Infinity;

  if (nearestZone) {
    // ── S_prox ───────────────────────────────────────────────
    if (distM <= 0) {
      sProx = 1.0;  // inside the zone
    } else {
      sProx = Math.max(0, 1 - distM / w.rDanger);
    }

    // ── S_eta ─────────────────────────────────────────────────
    if (d.speed > 0.1 && distM > 0) {
      // Angle between heading and bearing-to-zone (both in degrees)
      const bearingToTarget = bearingToZone(d.lng, d.lat, nearestZone);
      const deltaAngle = ((bearingToTarget - d.heading + 540) % 360) - 180; // [-180, 180]
      const cosTheta = Math.cos((deltaAngle * Math.PI) / 180);
      if (cosTheta > 0) {
        // Moving towards zone
        etaSec = distM / (d.speed * cosTheta);
        sEta = Math.max(0, 1 - etaSec / w.tDanger);
      }
      // If cosTheta ≤ 0 → moving away → sEta = 0
    }
  }

  // ── Weighted sum (normalised) ────────────────────────────
  const wTotal = w.wClass + w.wProx + w.wEta;
  const score = wTotal > 0
    ? (w.wClass * sClass + w.wProx * sProx + w.wEta * sEta) / wTotal
    : 0;

  return { score, sClass, sProx, sEta, distM: distM === Infinity ? -1 : distM, etaSec: etaSec === Infinity ? -1 : etaSec };
}

/**
 * Map a [0,1] threat score to an HSL color string.
 * 0 → hsl(100, 90%, 50%) green-yellow
 * 1 → hsl(0,   90%, 50%) red
 */
function getThreatColor(score: number): string {
  const hue = Math.round((1 - score) * 100);
  return `hsl(${hue}, 90%, 52%)`;
}


export default function App() {
  const [radars, setRadars] = useState<RadarConfig[]>(() => {
    const saved = localStorage.getItem('mitzpe_metzoda_radars');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error('Error parsing saved radars:', e);
      }
    }
    return [
      { id: 1, name: 'מכ"ם 1', ip: '192.168.1.100', isActive: false, homeLocation: [32.0853, 34.7818, 15], heading: 0, elevation: 0, pitch: 0, roll: 0, useImu: false, fadeThreshold: 5, freqChannel: 1, elFovMin: -40, elFovMax: 40, azFovMin: -60, azFovMax: 60, minRcs: -30, maxRcs: 10, maxRange: 2000, clutterWidth: 3 },
      { id: 2, name: 'מכ"ם 2', ip: '192.168.1.101', isActive: false, homeLocation: [32.0883, 34.7818, 15], heading: 90, elevation: 0, pitch: 0, roll: 0, useImu: false, fadeThreshold: 5, freqChannel: 2, elFovMin: -40, elFovMax: 40, azFovMin: -60, azFovMax: 60, minRcs: -30, maxRcs: 10, maxRange: 2000, clutterWidth: 3 },
      { id: 3, name: 'מכ"ם 3', ip: '192.168.1.102', isActive: false, homeLocation: [32.0883, 34.7858, 15], heading: 180, elevation: 0, pitch: 0, roll: 0, useImu: false, fadeThreshold: 5, freqChannel: 3, elFovMin: -40, elFovMax: 40, azFovMin: -60, azFovMax: 60, minRcs: -30, maxRcs: 10, maxRange: 2000, clutterWidth: 3 },
      { id: 4, name: 'מכ"ם 4', ip: '192.168.1.103', isActive: false, homeLocation: [32.0853, 34.7858, 15], heading: 270, elevation: 0, pitch: 0, roll: 0, useImu: false, fadeThreshold: 5, freqChannel: 4, elFovMin: -40, elFovMax: 40, azFovMin: -60, azFovMax: 60, minRcs: -30, maxRcs: 10, maxRange: 2000, clutterWidth: 3 },
    ];
  });
  const [selectedRadarId, setSelectedRadarId] = useState<number>(1);
  const [liveImuData, setLiveImuData] = useState<Record<number, { pitch: number; roll: number; yaw: number }>>({});
  const [detections, setDetections] = useState<Detection[]>([]);
  const [selectedDetection, setSelectedDetection] = useState<Detection | null>(null);
  const [helpField, setHelpField] = useState<string | null>(null);
  
  // Track Actions State
  const [ignoredDetections, setIgnoredDetections] = useState<Set<string>>(new Set());
  const [ignoredTracks, setIgnoredTracks] = useState<Set<string>>(new Set());
  const [trackHistory, setTrackHistory] = useState<Record<string, {pos: [number, number], time: number}[]>>({});

  // Fused Tracks State
  const [tracks, setTracks] = useState<FusedTrack[]>([]);
  const [trackHistory_fused, setTrackHistory_fused] = useState<Record<string, {pos: [number, number], time: number}[]>>({});
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() => {
    const saved = localStorage.getItem('mitzpe_metzoda_display_mode');
    return (saved === 'detections' || saved === 'tracks' || saved === 'both') ? saved as DisplayMode : 'tracks';
  });

  // Ignore Zones State
  const [ignoreZones, setIgnoreZones] = useState<IgnoreZone[]>(() => {
    const saved = localStorage.getItem('mitzpe_metzoda_ignore_zones');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error('Error parsing ignore zones:', e);
      }
    }
    return [];
  });
  const [showZonesModal, setShowZonesModal] = useState<boolean>(false);
  const [isDrawingZone, setIsDrawingZone] = useState(false);
  const [currentDrawPolygon, setCurrentDrawPolygon] = useState<[number, number][]>([]); // FIX: was missing
  const [showZoneHeightDialog, setShowZoneHeightDialog] = useState(false);
  const [newZoneHeights, setNewZoneHeights] = useState({ minAgl: 0, maxAgl: 1000 });
  const [newZoneName, setNewZoneName] = useState<string>('');
  const [radarStatuses, setRadarStatuses] = useState<Record<number, 'connecting' | 'connected' | 'error' | 'disconnected'>>({});

  // Language / i18n
  const [lang, setLang] = useState<'he' | 'en'>('he');

  const parameterHelp: Record<string, { title: string, text: string, range: string }> = {
    name: {
      title: lang === 'he' ? 'שם תצוגה' : 'Display Name',
      text: lang === 'he' ? 'שם מזהה ידידותי עבור המכ"ם במערכת.' : 'A friendly identification name for the radar in the system.',
      range: lang === 'he' ? 'טקסט חופשי' : 'Free text'
    },
    ip: {
      title: lang === 'he' ? 'כתובת IP' : 'IP Address',
      text: lang === 'he' ? 'כתובת הרשת של המכ"ם לחיבור נתונים ופקודות.' : 'The network address of the radar for data connection and control commands.',
      range: 'e.g., 192.168.1.100'
    },
    freqChannel: {
      title: lang === 'he' ? 'ערוץ תדר' : 'Frequency Channel',
      text: lang === 'he' ? 'ערוץ התדר האקטיבי של המכ"ם למניעת התאבכויות.' : 'The active frequency channel of the radar to avoid interference.',
      range: '1 - 4'
    },
    homeLocation: {
      title: lang === 'he' ? 'מיקום בסיס' : 'Home Location',
      text: lang === 'he' ? 'מיקום פיזי של המכ"ם (קו רוחב Latitude, קו אורך Longitude, וגובה ASL במטרים מעל פני הים).' : 'Physical location of the radar (Latitude, Longitude, and Altitude ASL in meters above sea level).',
      range: 'Lat: -90 to 90, Lng: -180 to 180, Alt: > 0'
    },
    heading: {
      title: lang === 'he' ? 'זווית כיוון (Heading)' : 'Radar Heading (Yaw)',
      text: lang === 'he' ? 'כיוון ההתקנה של המכ"ם ביחס לצפון האמיתי (במעלות).' : 'The installation direction of the radar relative to true North (in degrees).',
      range: '0° - 360°'
    },
    pitch: {
      title: lang === 'he' ? 'זווית עלרוד (Pitch / Elevation)' : 'Pitch Angle',
      text: lang === 'he' ? 'זווית הנטייה האנכית של המכ"ם מעל או מתחת לאופק.' : 'The vertical inclination angle of the radar above or below the horizon.',
      range: '-90° to 90°'
    },
    roll: {
      title: lang === 'he' ? 'זווית גלגול (Roll)' : 'Roll Angle',
      text: lang === 'he' ? 'זווית הנטייה הצידית של המכ"ם סביב ציר השידור.' : 'The lateral tilt angle of the radar around the transmission axis.',
      range: '-90° to 90°'
    },
    useImu: {
      title: lang === 'he' ? 'קבלת זוויות מהמכ"ם' : 'Get IMU Angles',
      text: lang === 'he' ? 'עדכון אוטומטי של זוויות הנטייה (Pitch & Roll) ישירות מחיישן ה-IMU הפנימי של המכ"ם.' : 'Automatically update inclination angles (Pitch & Roll) directly from the radar\'s internal IMU sensor.',
      range: 'Checkbox (ON/OFF)'
    },
    azFov: {
      title: lang === 'he' ? 'גזרת סריקה באזימוט' : 'Azimuth FOV',
      text: lang === 'he' ? 'גבולות זווית הגילוי באופק. המכ"ם יתעלם וימנע ממעקב מחוץ לטווח זה.' : 'Limits of the detection angle in azimuth. The radar will ignore and prevent tracks outside this range.',
      range: '-60° to +60°'
    },
    elFov: {
      title: lang === 'he' ? 'גזרת סריקה בהגבהה' : 'Elevation FOV',
      text: lang === 'he' ? 'גבולות זווית הגילוי בגובה. מומלץ להגביה את המינימום כדי לסנן החזרי קרקע.' : 'Limits of the detection angle in elevation. Raising the minimum is recommended to filter out ground clutter.',
      range: '-40° to +40°'
    },
    rcs: {
      title: lang === 'he' ? 'סינון RCS' : 'RCS Filter',
      text: lang === 'he' ? 'שטח החזר מכ"מי של המטרה ב-dBsm. משמש לסנן רעשים (מתחת למינימום) או מטרות גדולות מדי (מעל המקסימום).' : 'Radar Cross Section of the target in dBsm. Used to filter out noise (below min) or targets that are too large (above max).',
      range: 'e.g., -30 to +20'
    },
    maxRange: {
      title: lang === 'he' ? 'טווח גילוי מקסימלי' : 'Max Range',
      text: lang === 'he' ? 'הטווח המקסימלי במטרים שבו המכ"ם יתחיל לעקוב אחר מטרות.' : 'The maximum range in meters at which the radar will begin tracking targets.',
      range: '> 0m (e.g., 2000m)'
    },
    clutterWidth: {
      title: lang === 'he' ? 'רוחב מסנן החזרי קרקע' : 'Clutter Mask Width',
      text: lang === 'he' ? 'רוחב מסנן מהירות אפס (בדיסקיות דופלר) לסינון עלוות עצים ושיחים הנעים ברוח.' : 'Zero-velocity filter width (in Doppler bins) to filter out tree leaves and bushes moving in the wind.',
      range: '1 - 5 bins'
    }
  };

  const renderHelpButton = (field: string) => (
    <button 
      type="button"
      onClick={() => setHelpField(helpField === field ? null : field)}
      style={{
        background: 'rgba(255,255,255,0.1)',
        border: 'none',
        borderRadius: '50%',
        width: '16px',
        height: '16px',
        fontSize: '11px',
        color: 'var(--accent-cyan)',
        cursor: 'pointer',
        marginLeft: '6px',
        marginRight: '6px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 'bold',
        verticalAlign: 'middle'
      }}
      title={lang === 'he' ? 'הסבר על הפרמטר' : 'Parameter explanation'}
    >
      ?
    </button>
  );

  const renderHelpText = (field: string) => {
    if (helpField !== field) return null;
    const info = parameterHelp[field];
    if (!info) return null;
    return (
      <div style={{
        gridColumn: 'span 2',
        background: 'rgba(0, 229, 255, 0.08)',
        border: '1px solid rgba(0, 229, 255, 0.25)',
        padding: '0.6rem 0.8rem',
        borderRadius: '6px',
        fontSize: '0.82rem',
        color: '#fff',
        marginTop: '4px',
        marginBottom: '6px',
        lineHeight: '1.4',
        textAlign: lang === 'he' ? 'right' : 'left',
        direction: lang === 'he' ? 'rtl' : 'ltr'
      }}>
        <div style={{ fontWeight: 'bold', color: 'var(--accent-cyan)', marginBottom: '3px' }}>{info.title}</div>
        <div>{info.text}</div>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '3px' }}>
          <strong>{lang === 'he' ? 'ערכים אפשריים: ' : 'Possible values: '}</strong>{info.range}
        </div>
      </div>
    );
  };

  // Full translations table — all UI strings in both languages
  const t = {
    // Top bar
    masterOn:       lang === 'he' ? 'ראשי: פעיל'      : 'MASTER: ON',
    masterOff:      lang === 'he' ? 'ראשי: כבוי'      : 'MASTER: OFF',
    simulation:     lang === 'he' ? 'סימולציה'         : 'SIMULATION',
    live:           lang === 'he' ? 'שידור חי'         : 'LIVE',
    // Left panel
    radarLabel:     lang === 'he' ? 'מכ"ם'             : 'Radar',
    status:         lang === 'he' ? 'סטטוס'            : 'Status',
    transmitting:   lang === 'he' ? 'משדר'             : 'TRANSMITTING',
    standby:        lang === 'he' ? 'המתנה'            : 'STANDBY',
    homeLocation:   lang === 'he' ? 'מיקום בסיס'       : 'Home Location',
    altLabel:       lang === 'he' ? 'גובה ASL'          : 'ASL Altitude',
    fadeLabel:      lang === 'he' ? 'דעיכת גילוי'      : 'Detection Fade',
    thresholdLabel: lang === 'he' ? 'סף UAV'           : 'UAV Threshold',
    mapType:        lang === 'he' ? 'סוג מפה'          : 'Map Type',
    dark:           lang === 'he' ? 'כהה'              : 'Dark',
    satellite:      lang === 'he' ? 'לוויין'           : 'Satellite',
    filters:        lang === 'he' ? 'סינונים'          : 'Filters',
    zones:          lang === 'he' ? 'אזורים'           : 'Zones',
    drawZone:       lang === 'he' ? '+ שרטט אזור התעלמות' : '+ Draw Ignore Zone',
    // Right panel
    activeDetections: lang === 'he' ? 'גילויים פעילים'  : 'Active Detections',
    activeTracks:   lang === 'he' ? 'Tracks פעילים'   : 'Active Tracks',
    activeItems:    lang === 'he' ? 'מטרות פעילות'    : 'Active Targets',
    center:         lang === 'he' ? 'מרכז'             : 'Center',
    trailLengthLabel: lang === 'he' ? 'אורך שובל (שניות)' : 'Trail Length (sec)',
    drop:           lang === 'he' ? 'הסר'              : 'Drop',
    classLabel:     lang === 'he' ? 'סיווג'            : 'Classification',
    altitudeLabel:  lang === 'he' ? 'גובה (ASL/מעפ"ש)' : 'Altitude (ASL/AGL)',
    probUavLabel:   lang === 'he' ? 'הסתברות UAV'      : 'UAV Probability',
    uav:            lang === 'he' ? 'כלי טיס'     : 'UAV',
    unknown:        lang === 'he' ? 'לא ידוע'          : 'Unknown',
    bird:           lang === 'he' ? 'ציפור'            : 'Bird',
    target:         lang === 'he' ? 'מטרה'             : 'Target',
    // Filters modal
    filterTitle:    lang === 'he' ? 'סינון גילויים'    : 'Filter Detections',
    typeFilter:     lang === 'he' ? 'סוגי גילויים לתצוגה' : 'Target Types to Show',
    speedRange:     lang === 'he' ? 'טווח מהירות (m/s)': 'Speed Range (m/s)',
    aglRange:       lang === 'he' ? 'גובה מעפ"ש (מ\')'  : 'AGL Height (m)',
    minLabel:       lang === 'he' ? 'מינימום'          : 'Min',
    maxLabel:       lang === 'he' ? 'מקסימום'          : 'Max',
    apply:          lang === 'he' ? 'החל'              : 'Apply',
    // Zones modal
    zonesTitle:     lang === 'he' ? 'אזורי התעלמות'    : 'Ignore Zones',
    zoneItem:       lang === 'he' ? 'אזור'             : 'Zone',
    aglSuffix:      lang === 'he' ? 'מעפ"ש'            : 'AGL',
    drawPolygon:    lang === 'he' ? '+ שרטט פוליגון'   : '+ Draw Custom Polygon',
    close:          lang === 'he' ? 'סגור'             : 'Close',
    // Zone height dialog
    configZoneTitle: lang === 'he' ? 'הגדרת גבהי אזור התעלמות' : 'Configure Ignore Zone Altitudes',
    minAglLabel:    lang === 'he' ? 'גובה מינ\' מעפ"ש (מ\')' : 'Min Altitude AGL (m)',
    maxAglLabel:    lang === 'he' ? 'גובה מקס\' מעפ"ש (מ\')' : 'Max Altitude AGL (m)',
    cancel:         lang === 'he' ? 'ביטול'            : 'Cancel',
    saveZone:       lang === 'he' ? 'שמור אזור'        : 'Save Zone',
    // Config modal
    configTitle:    lang === 'he' ? 'הגדרות מכ"ם'     : 'Radar Configuration',
    radarIp:        lang === 'he' ? 'כתובת IP'         : 'Radar IP Address',
    radarLocation:  lang === 'he' ? 'מיקום מכ"ם (קו, אורך, גובה)' : 'Radar Home Location (Lat, Lng, Alt)',
    radarHeading:   lang === 'he' ? 'כיוון מכ"ם (מעלות)' : 'Radar Heading (deg)',
    radarElevation: lang === 'he' ? 'זווית הגבהה (Pitch) (מעלות)' : 'Elevation / Pitch Angle (deg)',
    radarRoll:      lang === 'he' ? 'זווית גלגול (Roll) (מעלות)' : 'Roll Angle (deg)',
    azFov:          lang === 'he' ? 'שדה ראייה אזימוט מינ\'/מקס\'' : 'Azimuth FOV Min/Max',
    save:           lang === 'he' ? 'שמור הגדרות'      : 'Save Settings',
    // Drawing mode
    drawModeMsg:    lang === 'he' ? 'מצב שרטוט: לחץ על המפה להוספת נקודות' : 'Draw Mode: Click map to add points',
    cancelDraw:     lang === 'he' ? 'ביטול'            : 'Cancel',
    finish:         lang === 'he' ? 'סיים'             : 'Finish',
    // Mouse telemetry
    latLabel:       lang === 'he' ? 'קו רוחב'         : 'Lat',
    lngLabel:       lang === 'he' ? 'קו אורך'         : 'Lng',
    dtmHeight:      lang === 'he' ? 'גובה שטח'        : 'DTM Height',
    // AGL label on marker
    aglMarker:      lang === 'he' ? 'מעפ"ש'            : 'AGL',
    // Threat Scoring and Defense Zones translations
    adminTitle:     lang === 'he' ? 'ניהול מערכת איומים' : 'Threat Assessment System',
    weightsTitle:   lang === 'he' ? 'משקולות סיווג ואיום' : 'Threat Scoring Weights',
    wClassLabel:    lang === 'he' ? 'משקל סיווג אובייקט'  : 'Classification Weight (W_class)',
    wProxLabel:     lang === 'he' ? 'משקל קרבה למרחב'    : 'Proximity Weight (W_prox)',
    wEtaLabel:      lang === 'he' ? 'משקל זמן הגעה (ETA)' : 'ETA Weight (W_eta)',
    rDangerLabel:   lang === 'he' ? 'רדיוס סכנה (מטרים)'  : 'Danger Radius (meters)',
    tDangerLabel:   lang === 'he' ? 'סף זמן הגעה (שניות)' : 'Danger ETA (seconds)',
    defenseZonesLabel: lang === 'he' ? 'מרחבי הגנה'       : 'Defense Zones',
    drawDefenseZone: lang === 'he' ? '+ שרטט מרחב הגנה'  : '+ Draw Defense Zone',
    noDefenseZones: lang === 'he' ? 'אין מרחבי הגנה מוגדרים' : 'No defense zones defined',
    threatScore:    lang === 'he' ? 'ציון איום'         : 'Threat Score',
    proximity:      lang === 'he' ? 'קרבה'              : 'Proximity',
    eta:            lang === 'he' ? 'זמן הגעה'          : 'ETA',
    drawingDefense: lang === 'he' ? 'מצב שרטוט מרחב הגנה: לחץ על המפה להוספת נקודות' : 'Drawing Defense Zone: Click map to add points',
    configDefenseZoneTitle: lang === 'he' ? 'הגדרת מרחב הגנה' : 'Configure Defense Zone',
    zoneNameLabel:  lang === 'he' ? 'שם המרחב'          : 'Zone Name',
    saveDefense:    lang === 'he' ? 'שמור מרחב הגנה'    : 'Save Defense Zone',
    debugMode:      lang === 'he' ? 'מצב דיבאג (הצגת מידע גולמי)' : 'Debug Mode (Raw Data)',
    filterFov:      lang === 'he' ? 'סינון גילויים מחוץ ל-FOV' : 'Filter detections outside FOV',
    // Fusion / Display mode
    fusionTitle:    lang === 'he' ? 'מנוע היתוך (Fusion)' : 'Fusion Engine',
    displayModeLabel: lang === 'he' ? 'מצב תצוגה' : 'Display Mode',
    modeDetections: lang === 'he' ? 'גילויים גולמיים בלבד' : 'Raw Detections Only',
    modeTracks:     lang === 'he' ? 'Tracks מהותכים בלבד' : 'Fused Tracks Only',
    modeBoth:       lang === 'he' ? 'גילויים + Tracks' : 'Both Detections & Tracks',
    fusionParamsLabel: lang === 'he' ? 'פרמטרי קורלציה' : 'Correlation Parameters',
    maxDistLabel:   lang === 'he' ? 'מרחק gate מקסימלי (מ\')' : 'Max Position Gate (m)',
    maxTimeLabel:   lang === 'he' ? 'זמן מקסימלי ללא עדכון (שנ\')' : 'Max Stale Time (sec)',
    minConfirmLabel: lang === 'he' ? 'גילויים מינ\' לאישור Track' : 'Min Detections to Confirm',
    maxHeadingLabel: lang === 'he' ? 'gate כיוון מקסימלי (מעלות)' : 'Max Heading Gate (deg)',
    maxSpeedRatioLabel: lang === 'he' ? 'יחס מהירות מקסימלי' : 'Max Speed Ratio',
    wPositionLabel: lang === 'he' ? 'משקל מיקום בעלות' : 'Position Weight in Cost',
    wVelocityLabel: lang === 'he' ? 'משקל מהירות בעלות' : 'Velocity Weight in Cost',
    kalmanQLabel:   lang === 'he' ? 'מהירות תגובה לתמרונים (Q)' : 'Maneuver Responsiveness (Q)',
    kalmanRLabel:   lang === 'he' ? 'עוצמת החלקה ויציבות (R)' : 'Smoothing & Stability (R)',
    crossRadarLabel: lang === 'he' ? 'קורלציה בין מכ"מים' : 'Cross-Radar Fusion',
    kinematicClassLabel: lang === 'he' ? 'דרוס סיווג מכ"ם ע"פ חוק קינמטי (לא מומלץ)' : 'Override Radar AI with Kinematic Heuristics',
    classFusionModeLabel: lang === 'he' ? 'שיטת מיזוג סיווג' : 'Classification Fusion Mode',
    trackLabel:     lang === 'he' ? 'Track' : 'Track',
    radarsLabel:    lang === 'he' ? 'מכ"מים' : 'radars',
  };

  // Defense Zones state
  const [defenseZones, setDefenseZones] = useState<DefenseZone[]>(() => {
    const saved = localStorage.getItem('mitzpe_metzoda_defense_zones');
    return saved ? JSON.parse(saved) : [];
  });
  const [threatWeights, setThreatWeights] = useState<ThreatWeights>(() => {
    const saved = localStorage.getItem('mitzpe_metzoda_threat_weights');
    return saved ? JSON.parse(saved) : {
      wClass: 0.3,
      wProx: 0.4,
      wEta: 0.3,
      rDanger: 1000,
      tDanger: 120
    };
  });
  const [showAdminModal, setShowAdminModal] = useState<boolean>(false);
  const [isDrawingDefenseZone, setIsDrawingDefenseZone] = useState<boolean>(false);
  const [currentDrawDefensePolygon, setCurrentDrawDefensePolygon] = useState<[number, number][]>([]);
  const [showDefenseZoneDialog, setShowDefenseZoneDialog] = useState<boolean>(false);
  const [newDefenseZoneName, setNewDefenseZoneName] = useState<string>('');
  const [isDebugMode, setIsDebugMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('mitzpe_metzoda_is_debug_mode');
    return saved ? JSON.parse(saved) : false;
  });
  const [filterOutsideFov, setFilterOutsideFov] = useState<boolean>(() => {
    const saved = localStorage.getItem('mitzpe_metzoda_filter_outside_fov');
    return saved ? JSON.parse(saved) : true;
  });

  // Draggable panels positions
  const [debugPos, setDebugPos] = useState({ x: 20, y: window.innerHeight - 450 });
  const [isDraggingDebug, setIsDraggingDebug] = useState(false);
  const [dragStartDebug, setDragStartDebug] = useState({ x: 0, y: 0 });

  const [playbackPos, setPlaybackPos] = useState({ x: window.innerWidth / 2 - 300, y: window.innerHeight - 200 });
  const [isDraggingPlayback, setIsDraggingPlayback] = useState(false);
  const [dragStartPlayback, setDragStartPlayback] = useState({ x: 0, y: 0 });

  // Map location selection
  const [isSelectingLocationFromMap, setIsSelectingLocationFromMap] = useState<boolean>(false);

  // Threat alert management states
  const [alertThreshold, setAlertThreshold] = useState<number>(() => {
    const saved = localStorage.getItem('mitzpe_metzoda_alert_threshold');
    return saved ? parseFloat(saved) : 0.70;
  });
  const [alertSoundType, setAlertSoundType] = useState<'siren' | 'sonar' | 'beeps' | 'warble'>(() => {
    const saved = localStorage.getItem('mitzpe_metzoda_alert_sound_type');
    return (saved === 'siren' || saved === 'sonar' || saved === 'beeps' || saved === 'warble') ? saved : 'siren';
  });
  const [alertPopupDuration, setAlertPopupDuration] = useState<number>(() => {
    const saved = localStorage.getItem('mitzpe_metzoda_alert_popup_duration');
    return saved ? parseInt(saved, 10) : 0; // default 0 (disappear when target disappears)
  });

  type AlertPopupItem = {
    id: string;
    score: number;
    alt: number;
    lng: number;
    lat: number;
    speed: number;
    timestamp: number;
    isOffline?: boolean;
  };
  const [alertPopups, setAlertPopups] = useState<AlertPopupItem[]>([]);
  const [closedThreatAlertIds, setClosedThreatAlertIds] = useState<Set<string>>(new Set());
  const focusedThreatIdsRef = useRef<Set<string>>(new Set());

  const playAlertSound = useCallback((soundTypeOverride?: 'siren' | 'sonar' | 'beeps' | 'warble') => {
    try {
      const type = soundTypeOverride || alertSoundType;
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      
      osc.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      
      if (type === 'siren') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(800, audioCtx.currentTime);
        osc.frequency.linearRampToValueAtTime(1200, audioCtx.currentTime + 0.25);
        osc.frequency.linearRampToValueAtTime(800, audioCtx.currentTime + 0.5);
        osc.frequency.linearRampToValueAtTime(1200, audioCtx.currentTime + 0.75);
        osc.frequency.linearRampToValueAtTime(800, audioCtx.currentTime + 1.0);
        gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 1.2);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 1.2);
      } else if (type === 'sonar') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1500, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1000, audioCtx.currentTime + 0.4);
        gainNode.gain.setValueAtTime(0.4, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.5);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 1.5);
      } else if (type === 'beeps') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(950, audioCtx.currentTime);
        gainNode.gain.setValueAtTime(0.0, audioCtx.currentTime);
        gainNode.gain.setValueAtTime(0.25, audioCtx.currentTime + 0.05);
        gainNode.gain.setValueAtTime(0.0, audioCtx.currentTime + 0.2);
        gainNode.gain.setValueAtTime(0.25, audioCtx.currentTime + 0.25);
        gainNode.gain.setValueAtTime(0.0, audioCtx.currentTime + 0.4);
        gainNode.gain.setValueAtTime(0.25, audioCtx.currentTime + 0.45);
        gainNode.gain.setValueAtTime(0.0, audioCtx.currentTime + 0.6);
        gainNode.gain.setValueAtTime(0.25, audioCtx.currentTime + 0.65);
        gainNode.gain.setValueAtTime(0.0, audioCtx.currentTime + 0.8);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.9);
      } else if (type === 'warble') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(900, audioCtx.currentTime);
        for (let i = 0; i < 10; i++) {
          const t = i * 0.1;
          osc.frequency.setValueAtTime(i % 2 === 0 ? 1000 : 700, audioCtx.currentTime + t);
        }
        gainNode.gain.setValueAtTime(0.35, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 1.0);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 1.0);
      }
    } catch (err) {
      console.error('Failed to play alert sound:', err);
    }
  }, [alertSoundType]);

  useEffect(() => {
    localStorage.setItem('mitzpe_metzoda_alert_threshold', alertThreshold.toString());
  }, [alertThreshold]);

  useEffect(() => {
    localStorage.setItem('mitzpe_metzoda_alert_sound_type', alertSoundType);
  }, [alertSoundType]);

  useEffect(() => {
    localStorage.setItem('mitzpe_metzoda_alert_popup_duration', alertPopupDuration.toString());
  }, [alertPopupDuration]);

  useEffect(() => {
    const handleResize = () => {
      setPlaybackPos({
        x: window.innerWidth / 2 - 300,
        y: window.innerHeight - 200
      });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingDebug) {
        setDebugPos({
          x: e.clientX - dragStartDebug.x,
          y: e.clientY - dragStartDebug.y
        });
      }
      if (isDraggingPlayback) {
        setPlaybackPos({
          x: e.clientX - dragStartPlayback.x,
          y: e.clientY - dragStartPlayback.y
        });
      }
    };

    const handleMouseUp = () => {
      setIsDraggingDebug(false);
      setIsDraggingPlayback(false);
    };

    if (isDraggingDebug || isDraggingPlayback) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingDebug, isDraggingPlayback, dragStartDebug, dragStartPlayback]);

  const handleRadarDragEnd = (radarId: number, evt: any) => {
    const { lng, lat } = evt.lngLat;
    setRadars(prev => prev.map(r => {
      if (r.id === radarId) {
        return {
          ...r,
          homeLocation: [lat, lng, r.homeLocation[2]]
        };
      }
      return r;
    }));
  };

  // Refs for callbacks
  const radarsRef = useRef(radars);
  useEffect(() => { radarsRef.current = radars; }, [radars]);
  const filterOutsideFovRef = useRef(filterOutsideFov);
  useEffect(() => { filterOutsideFovRef.current = filterOutsideFov; }, [filterOutsideFov]);


  // Helper: get terrain elevation at a lat/lng from MapLibre, then compute AGL
  const getTerrainAgl = useCallback((lng: number, lat: number, altAsl: number): number => {
    if (!mapRef.current) return Math.round(altAsl);
    const map = mapRef.current.getMap();
    if (!map?.queryTerrainElevation) return Math.round(altAsl);
    const terrainElev = map.queryTerrainElevation([lng, lat]) ?? 0;
    return Math.round(altAsl - terrainElev);
  }, []);


  // Sim tracks ref - persistent tracks for realistic drone/bird movement
  const simTracksRef = useRef<globalThis.Map<string, SimTrack>>(new globalThis.Map());

  // Map state
  const mapRef = useRef<any>(null);
  const [viewState, setViewState] = useState({
    longitude: 34.7818,
    latitude: 32.0853,
    zoom: 14,
    pitch: 0,
    bearing: 0
  });
  
  const [mouseInfo, setMouseInfo] = useState({ lng: 0, lat: 0, elevation: 0 });

  // Modes & UI States
  const [appMode, setAppMode] = useState<'simulation' | 'live' | 'playback'>(() => {
    const saved = localStorage.getItem('mitzpe_metzoda_app_mode');
    return (saved === 'live' || saved === 'playback' || saved === 'simulation') ? saved : 'simulation';
  });
  const isSimulationMode = appMode === 'simulation';
  
  const [simConfig, setSimConfig] = useState(() => {
    const saved = localStorage.getItem('mitzpe_metzoda_sim_config');
    return saved ? JSON.parse(saved) : { constantAsl: true };
  });
  const [showSimSettingsModal, setShowSimSettingsModal] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingFilename, setRecordingFilename] = useState('');
  const [maxRecordingDuration, setMaxRecordingDuration] = useState(() => {
    const saved = localStorage.getItem('mitzpe_metzoda_max_rec_dur');
    return saved ? parseInt(saved, 10) : 10;
  });
  const [showConfigModal, setShowConfigModal] = useState<boolean>(false);
  
  // Playback & Recording State
  const [playbackPackets, setPlaybackPackets] = useState<any[]>([]);
  const [playbackTime, setPlaybackTime] = useState<number>(0);
  const [playbackDuration, setPlaybackDuration] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [playbackFilesList, setPlaybackFilesList] = useState<any[]>([]);
  const [selectedPlaybackFile, setSelectedPlaybackFile] = useState<string>('');
  const [showRenameModal, setShowRenameModal] = useState<boolean>(false);
  const [fileToRename, setFileToRename] = useState<{ oldName: string; defaultName: string } | null>(null);
  const [newFileNameInput, setNewFileNameInput] = useState<string>('');
  const [showFilterModal, setShowFilterModal] = useState<boolean>(false);
  const [mapType, setMapType] = useState<'dark' | 'satellite'>(() => {
    const saved = localStorage.getItem('mitzpe_metzoda_map_type');
    return saved ? JSON.parse(saved) : 'dark';
  });
  const [wsStatus, setWsStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [uavThreshold, setUavThreshold] = useState<number>(() => {
    const saved = localStorage.getItem('mitzpe_metzoda_uav_threshold');
    return saved ? parseFloat(saved) : 0.5;
  });

  const getClassification = useCallback((d: Detection): 'drone' | 'unknown' | 'bird' => {
    if (d.classification === 'bird') return 'bird';
    const prob = d.probUAV !== undefined ? d.probUAV : (d.classification === 'drone' ? 1.0 : 0.0);
    return prob >= uavThreshold ? 'drone' : 'unknown';
  }, [uavThreshold]);

  // Filters State
  const [filters, setFilters] = useState<MapFilters>(() => {
    const saved = localStorage.getItem('mitzpe_metzoda_filters');
    return saved ? JSON.parse(saved) : {
      showDrone: true,
      showUnknown: true,
      showBird: true,
      minSpeed: 0,
      maxSpeed: 100, // m/s
      minAgl: -50,   // meters
      maxAgl: 1000,   // meters
      trailLengthSeconds: 5,
      minRcs: -50,
      maxRcs: 30
    };
  });

  // Sync settings to localStorage when they change
  useEffect(() => {
    localStorage.setItem('mitzpe_metzoda_radars', JSON.stringify(radars));
  }, [radars]);

  useEffect(() => {
    localStorage.setItem('mitzpe_metzoda_uav_threshold', uavThreshold.toString());
  }, [uavThreshold]);

  useEffect(() => {
    localStorage.setItem('mitzpe_metzoda_ignore_zones', JSON.stringify(ignoreZones));
  }, [ignoreZones]);

  useEffect(() => {
    localStorage.setItem('mitzpe_metzoda_defense_zones', JSON.stringify(defenseZones));
  }, [defenseZones]);

  useEffect(() => {
    localStorage.setItem('mitzpe_metzoda_threat_weights', JSON.stringify(threatWeights));
  }, [threatWeights]);

  useEffect(() => {
    localStorage.setItem('mitzpe_metzoda_is_debug_mode', JSON.stringify(isDebugMode));
  }, [isDebugMode]);

  useEffect(() => {
    localStorage.setItem('mitzpe_metzoda_filter_outside_fov', JSON.stringify(filterOutsideFov));
  }, [filterOutsideFov]);

  useEffect(() => {
    localStorage.setItem('mitzpe_metzoda_app_mode', appMode);
    setDetections([]);
    setTrackHistory({});
    setSelectedDetection(null);
    setIsPlaying(false);
    setPlaybackTime(0);
  }, [appMode]);

  useEffect(() => {
    localStorage.setItem('mitzpe_metzoda_sim_config', JSON.stringify(simConfig));
  }, [simConfig]);

  useEffect(() => {
    localStorage.setItem('mitzpe_metzoda_max_rec_dur', maxRecordingDuration.toString());
  }, [maxRecordingDuration]);

  useEffect(() => {
    localStorage.setItem('mitzpe_metzoda_map_type', JSON.stringify(mapType));
  }, [mapType]);

  useEffect(() => {
    localStorage.setItem('mitzpe_metzoda_filters', JSON.stringify(filters));
  }, [filters]);

  useEffect(() => {
    localStorage.setItem('mitzpe_metzoda_display_mode', displayMode);
  }, [displayMode]);

  const selectedRadar = radars.find((r) => r.id === selectedRadarId)!;

  // ─── processNewTrack: fused track ingestion (mirrors processNewDetection) ───
  const processNewTrack = useCallback((newTrack: FusedTrack) => {
    if (ignoredTracks.has(newTrack.id)) return;

    setTracks(prev => {
      const filtered = prev.filter(t => t.id !== newTrack.id);
      return [...filtered, newTrack];
    });

    setTrackHistory_fused(prev => {
      const existing = prev[newTrack.id] || [];
      const updated = [...existing, { pos: [newTrack.lng, newTrack.lat] as [number, number], time: Date.now() }];
      const cutoff = Date.now() - 60000;
      return { ...prev, [newTrack.id]: updated.filter(p => p.time > cutoff) };
    });
  }, [ignoredTracks]);

  // fusionConfigState: mirrors backend fusionConfig for the admin UI inputs
  const [fusionConfigState, setFusionConfigState] = useState<any>({
    maxAssocDistM: 15, maxAssocTimeSec: 10, minDetectionsToConfirm: 2,
    classificationFusionMode: 'max_prob', crossRadarFusion: true,
    maxHeadingDiffDeg: 60, maxSpeedRatioFactor: 2.5, wPosition: 0.6, wVelocity: 0.4,
    enableKinematicClassification: false
  });
  useEffect(() => {
    fetch('/api/fusion/config')
      .then(r => r.json())
      .then(cfg => setFusionConfigState(cfg))
      .catch(() => {/* backend may not be running in simulation mode */});
  }, []);

  const processNewDetection = useCallback((newDet: Detection) => {
    if (ignoredDetections.has(newDet.id)) return;

    if (filterOutsideFovRef.current && newDet.raw && newDet.radarId) {
      const radar = radarsRef.current.find(r => r.id === newDet.radarId);
      if (radar) {
        const az = newDet.raw.relativeAzimuth_deg;
        const el = newDet.raw.relativeElevation_deg;
        if (az < radar.azFovMin || az > radar.azFovMax || el < radar.elFovMin || el > radar.elFovMax) {
          return; // filtered out
        }
      }
    }

    setDetections(prev => {
      const filtered = prev.filter(p => p.id !== newDet.id);
      return [...filtered, newDet];
    });

    setTrackHistory(prev => {
      const existing = prev[newDet.id] || [];
      const updated = [...existing, { pos: [newDet.lng, newDet.lat] as [number, number], time: Date.now() }];
      const cutoff = Date.now() - 60000;
      return { ...prev, [newDet.id]: updated.filter(p => p.time > cutoff) };
    });
  }, [ignoredDetections]);

  // ─── processBatch: High-performance ingestion for grouped websocket messages ───
  const processBatch = useCallback((batch: any[]) => {
    const newDets: Detection[] = [];
    const newTracks: FusedTrack[] = [];
    const newImus: Record<number, any> = {};
    const now = Date.now();

    for (const msg of batch) {
      if (msg.type === 'imu') {
        const rid = typeof msg.radarId === 'number' ? msg.radarId : parseInt(msg.radarId, 10);
        newImus[rid] = { pitch: msg.pitch, roll: msg.roll, yaw: msg.yaw };
      } else if (msg.type === 'track' && msg.id) {
        if (!ignoredTracks.has(msg.id)) {
          newTracks.push(msg as FusedTrack);
        }
      } else if (msg.id) {
        if (!ignoredDetections.has(msg.id)) {
          let keep = true;
          if (filterOutsideFovRef.current && msg.raw && msg.radarId) {
            const radar = radarsRef.current.find(r => r.id === msg.radarId);
            if (radar) {
              const az = msg.raw.relativeAzimuth_deg;
              const el = msg.raw.relativeElevation_deg;
              if (az < radar.azFovMin || az > radar.azFovMax || el < radar.elFovMin || el > radar.elFovMax) keep = false;
            }
          }
          if (keep) {
            newDets.push({
              ...msg,
              classification: msg.type === 'drone' ? 'drone' : 'unknown',
              probUAV: msg.probUAV,
              lastUpdated: now
            });
          }
        }
      }
    }

    if (Object.keys(newImus).length > 0) {
      setLiveImuData(prev => ({ ...prev, ...newImus }));
    }

    if (newTracks.length > 0) {
      setTracks(prev => {
        const obj: Record<string, FusedTrack> = {};
        prev.forEach(t => obj[t.id] = t);
        newTracks.forEach(t => obj[t.id] = t);
        return Object.values(obj);
      });
      setTrackHistory_fused(prev => {
        const next = { ...prev };
        const cutoff = now - 60000;
        newTracks.forEach(t => {
          const existing = next[t.id] || [];
          const lastPoint = existing[existing.length - 1];
          if (!lastPoint || lastPoint.pos[0] !== t.lng || lastPoint.pos[1] !== t.lat) {
            next[t.id] = [...existing, { pos: [t.lng, t.lat] as [number, number], time: now }].filter(p => p.time > cutoff);
          } else {
            next[t.id] = existing.filter(p => p.time > cutoff);
          }
        });
        return next;
      });
    }

    if (newDets.length > 0) {
      setDetections(prev => {
        const obj: Record<string, Detection> = {};
        prev.forEach(d => obj[d.id] = d);
        newDets.forEach(d => obj[d.id] = d);
        return Object.values(obj);
      });
      setTrackHistory(prev => {
        const next = { ...prev };
        const cutoff = now - 60000;
        newDets.forEach(d => {
          const existing = next[d.id] || [];
          const lastPoint = existing[existing.length - 1];
          if (!lastPoint || lastPoint.pos[0] !== d.lng || lastPoint.pos[1] !== d.lat) {
            next[d.id] = [...existing, { pos: [d.lng, d.lat] as [number, number], time: now }].filter(p => p.time > cutoff);
          } else {
            next[d.id] = existing.filter(p => p.time > cutoff);
          }
        });
        return next;
      });
    }
  }, [ignoredDetections, ignoredTracks]);

  // WebSocket Connection for Live Mode
  const wsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    if (appMode === 'live') {
      setWsStatus('connecting');
      const ws = new WebSocket('ws://localhost:8080');
      wsRef.current = ws;
      ws.onopen = () => {
        setWsStatus('connected');
        // Send radar configs so server knows about them
        ws.send(JSON.stringify({
          action: 'configure',
          radars: radars
        }));
        // Auto-turn-on only radars that are already marked active
        radars.filter(r => r.isActive).forEach(r => {
          ws.send(JSON.stringify({ action: 'turnOn', radarId: r.id }));
        });
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'recordingStatus') {
            setIsRecording(data.state === 'recording');
            setRecordingFilename(data.filename || '');
            if (data.state === 'stopped') {
              setIsRecording(false);
              const oldFilename = data.filename || recordingFilename;
              if (oldFilename) {
                setFileToRename({ oldName: oldFilename, defaultName: oldFilename });
                setNewFileNameInput(oldFilename.replace('.json', ''));
                setShowRenameModal(true);
              }
            }
            return;
          }

          // Status messages from server (immediate feedback) or from daemon
          if (data.type === 'status' && data.radarId != null) {
            const rid = typeof data.radarId === 'number' ? data.radarId : parseInt(data.radarId, 10);
            const state = data.state; // 'connecting' | 'connected' | 'off'
            if (state === 'connecting') {
              setRadarStatuses(prev => ({ ...prev, [rid]: 'connecting' }));
            } else if (state === 'off') {
              setRadarStatuses(prev => ({ ...prev, [rid]: 'disconnected' }));
            } else {
              // daemon sent status without state field OR state='connected'
              setRadarStatuses(prev => ({ ...prev, [rid]: 'connected' }));
              // Also mark radar as active in state since it's confirmed working
              setRadars(prev => prev.map(r => r.id === rid ? { ...r, isActive: true } : r));
            }
            return;
          }
          if (data.type === 'error' && data.radarId != null) {
            const rid = typeof data.radarId === 'number' ? data.radarId : parseInt(data.radarId, 10);
            setRadarStatuses(prev => ({ ...prev, [rid]: 'error' }));
            return;
          }

          // Handle batched payload
          if (data.type === 'batch' && Array.isArray(data.data)) {
            processBatch(data.data);
            return;
          }

          // Legacy single messages
          if (data.type === 'imu') {
            processBatch([data]);
            return;
          }
          if (data.type === 'track' && data.id) {
            processBatch([data]);
            return;
          }
          if (data.id) {
            processBatch([data]);
          }
        } catch(e) {}
      };
      ws.onclose = () => setWsStatus('disconnected');
      return () => ws.close();
    } else {
      setWsStatus('disconnected');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appMode]);

  // Recording action handlers
  const startRecording = async () => {
    try {
      const response = await fetch('/api/recordings/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxDuration: maxRecordingDuration })
      });
      const resData = await response.json();
      if (resData.success) {
        setIsRecording(true);
        setRecordingFilename(resData.filename);
      } else {
        alert(resData.error || 'Failed to start recording');
      }
    } catch (e: any) {
      alert('Error starting recording: ' + e.message);
    }
  };

  const stopRecording = async () => {
    try {
      const response = await fetch('/api/recordings/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const resData = await response.json();
      if (resData.success) {
        setIsRecording(false);
        setFileToRename({ oldName: resData.filename, defaultName: resData.filename });
        setNewFileNameInput(resData.filename.replace('.json', ''));
        setShowRenameModal(true);
      } else {
        alert(resData.error || 'Failed to stop recording');
      }
    } catch (e: any) {
      alert('Error stopping recording: ' + e.message);
    }
  };

  const handleRenameFile = async () => {
    if (!fileToRename || !newFileNameInput.trim()) return;
    const oldName = fileToRename.oldName;
    let newName = newFileNameInput.trim();
    if (!newName.endsWith('.json')) newName += '.json';
    
    try {
      const response = await fetch('/api/recordings/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldName, newName })
      });
      const resData = await response.json();
      if (resData.success) {
        setShowRenameModal(false);
        setFileToRename(null);
        if (appMode === 'playback') {
          fetchRecordingsList();
        }
      } else {
        alert(resData.error || 'Failed to rename file');
      }
    } catch (e: any) {
      alert('Error renaming file: ' + e.message);
    }
  };

  const fetchRecordingsList = async () => {
    try {
      const response = await fetch('/api/recordings');
      const data = await response.json();
      if (Array.isArray(data)) {
        setPlaybackFilesList(data);
      }
    } catch (e) {
      console.error('Failed to fetch recordings list:', e);
    }
  };

  const deleteRecordingFile = async (filename: string) => {
    if (!confirm(lang === 'he' ? `האם למחוק את ההקלטה ${filename}?` : `Delete recording ${filename}?`)) return;
    try {
      const response = await fetch(`/api/recordings/${filename}`, { method: 'DELETE' });
      const resData = await response.json();
      if (resData.success) {
        if (selectedPlaybackFile === filename) {
          setSelectedPlaybackFile('');
          setPlaybackPackets([]);
          setPlaybackTime(0);
          setPlaybackDuration(0);
          setIsPlaying(false);
          setDetections([]);
        }
        fetchRecordingsList();
      } else {
        alert(resData.error || 'Failed to delete file');
      }
    } catch (e: any) {
      alert('Error deleting file: ' + e.message);
    }
  };

  useEffect(() => {
    if (appMode === 'playback') {
      fetchRecordingsList();
    }
  }, [appMode]);

  // Cleanup old detections
  useEffect(() => {
    if (appMode === 'playback') return;
    const interval = setInterval(() => {
      const now = Date.now();
      setDetections(prev => {
        const kept: Detection[] = [];
        const removedIds: string[] = [];
        
        for (const d of prev) {
          const sourceRadar = radars.find(r => r.id === d.radarId) || selectedRadar;
          const thresholdMs = sourceRadar.fadeThreshold * 1000;
          if ((now - d.lastUpdated) < thresholdMs) {
            kept.push(d);
          } else {
            removedIds.push(d.id);
          }
        }

        if (removedIds.length > 0) {
          // Clean up track history and trail status for removed detections
          setTrackHistory(prevHistory => {
            const updated = { ...prevHistory };
            removedIds.forEach(id => { delete updated[id]; });
            return updated;
          });
        }
        
        if (selectedDetection && removedIds.includes(selectedDetection.id)) {
          setSelectedDetection(null);
        }
        return kept;
      });

      // Also clean up expired fused tracks
      setTracks(prev => {
        const kept: FusedTrack[] = [];
        const removedIds: string[] = [];
        for (const tr of prev) {
          // Use the longest fade threshold among all contributing radars
          const maxFade = Math.max(...(tr.radarIds || []).map(rid => {
            const r = radars.find(x => x.id === rid);
            return r ? r.fadeThreshold : selectedRadar.fadeThreshold;
          })) * 1000;
          if ((now - tr.lastUpdated) < maxFade) {
            kept.push(tr);
          } else {
            removedIds.push(tr.id);
          }
        }
        if (removedIds.length > 0) {
          setTrackHistory_fused(prevHistory => {
            const updated = { ...prevHistory };
            removedIds.forEach(id => { delete updated[id]; });
            return updated;
          });
          if (selectedDetection && removedIds.includes(selectedDetection.id)) {
            setSelectedDetection(null);
          }
        }
        return kept;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [radars, selectedDetection, selectedRadar]);

  // Simulation Loop - persistent tracks with realistic drone/bird movement
  useEffect(() => {
    if (!isSimulationMode) {
      // Clear all sim tracks when leaving simulation mode
      simTracksRef.current.clear();
      return;
    }

    const TICK_MS = 500; // 2 updates per second for smooth movement
    const MAX_TRACKS_PER_RADAR = 4;

    const interval = setInterval(() => {
      const now = Date.now();
      const tracks = simTracksRef.current;

      // --- Step 1: Spawn new tracks for each ACTIVE radar ---
      radars.forEach(radar => {
        if (!radar.isActive) return; // respect power button in simulation
        const lat = Number(radar.homeLocation?.[0]);
        const lng = Number(radar.homeLocation?.[1]);
        if (!isFinite(lat) || !isFinite(lng) || lat === 0 || lng === 0) return;

        const myTracks = [...tracks.values()].filter(t => t.radarId === radar.id);
        if (myTracks.length >= MAX_TRACKS_PER_RADAR) return; // enough tracks already
        if (Math.random() > 0.25) return; // ~25% chance to spawn a new track each tick

        const azMin = Number(radar.azFovMin) || -60;
        const azMax = Number(radar.azFovMax) || 60;
        const maxR  = Number(radar.maxRange) || 2000;
        const radarHeading = Number(radar.heading) || 0;

        // Spawn near the far edge of the FOV (coming in from outside)
        const spawnDist = maxR * (0.7 + Math.random() * 0.3);
        const spawnBearing = radarHeading + azMin + Math.random() * (azMax - azMin);
        const spawnPt = turf.destination(turf.point([lng, lat]), spawnDist, spawnBearing, { units: 'meters' });

        const isDrone = Math.random() > 0.3;
        const trackId = `sim-${radar.id}-${now}-${Math.random().toString(36).slice(2, 6)}`;

        // Drone flies toward the radar (inbound), bird moves more randomly
        const inboundBearing = (spawnBearing + 180) % 360; // point back toward radar
        const trackHeading = isDrone
          ? inboundBearing + (Math.random() * 30 - 15)   // drones mostly inbound ±15°
          : Math.random() * 360;                          // birds go any direction

        const track: SimTrack = {
          id: trackId,
          radarId: radar.id,
          lat: spawnPt.geometry.coordinates[1],
          lng: spawnPt.geometry.coordinates[0],
          alt: (Number(radar.homeLocation[2]) || 0) + (isDrone ? 50 + Math.random() * 200 : 10 + Math.random() * 100),
          heading: trackHeading,
          speed: isDrone ? 8 + Math.random() * 22 : 3 + Math.random() * 10,  // drone 8-30 m/s, bird 3-13 m/s
          classification: isDrone ? 'drone' : 'bird',
          confidence: isDrone ? 0.75 + Math.random() * 0.2 : 0.5 + Math.random() * 0.3,
          createdAt: now,
          ttl: isDrone ? 45000 + Math.random() * 30000 : 20000 + Math.random() * 20000, // 45-75s drone, 20-40s bird
          probUAV: isDrone ? 0.75 + Math.random() * 0.2 : 0.05 + Math.random() * 0.2,
        };
        tracks.set(trackId, track);
      });

      // --- Step 2: Advance all existing tracks ---
      const tracksToDelete: string[] = [];
      tracks.forEach((track, id) => {
        // Remove tracks from inactive radars or expired tracks
        const ownerRadar = radars.find(r => r.id === track.radarId);
        if (!ownerRadar?.isActive || (now - track.createdAt) > track.ttl) {
          tracksToDelete.push(id);
          return;
        }

        // Move track forward: distance = speed * time
        const distMeters = track.speed * (TICK_MS / 1000);
        try {
          const newPt = turf.destination(
            turf.point([track.lng, track.lat]),
            distMeters,
            track.heading,
            { units: 'meters' }
          );

          // Slight heading drift (banking): drones ±2°/tick, birds ±8°/tick
          const drift = track.classification === 'drone'
            ? (Math.random() - 0.5) * 4
            : (Math.random() - 0.5) * 16;

          // Altitude variation: drones hold altitude ±5m, birds vary ±15m (disabled if constant ASL is checked)
          const altDrift = simConfig.constantAsl
            ? 0
            : (track.classification === 'drone'
              ? (Math.random() - 0.5) * 10
              : (Math.random() - 0.5) * 30);

          tracks.set(id, {
            ...track,
            lat: newPt.geometry.coordinates[1],
            lng: newPt.geometry.coordinates[0],
            alt: Math.max(0, track.alt + altDrift),
            heading: (track.heading + drift + 360) % 360,
          });
        } catch (e) {
          tracksToDelete.push(id);
        }
      });

      // Clean up expired / orphaned tracks
      tracksToDelete.forEach(id => {
        tracks.delete(id);
        // Remove from detections state too
        setDetections(prev => prev.filter(d => d.id !== id));
      });

      // --- Step 3: Emit updated positions as detections ---
      tracks.forEach(track => {
        const det: Detection = {
          id: track.id,
          radarId: track.radarId,
          lat: track.lat,
          lng: track.lng,
          alt: track.alt,
          classification: track.classification,
          confidence: track.confidence,
          speed: track.speed,
          heading: track.heading,
          lastUpdated: now,
          probUAV: track.probUAV,
        };
        processNewDetection(det);

        // Also directly promote sim tracks to fused tracks (confirmed immediately in simulation)
        const fusedTrk: FusedTrack = {
          id: `TRK-SIM-${track.id}`,
          radarIds: [track.radarId],
          lat: track.lat,
          lng: track.lng,
          alt: track.alt,
          speed: track.speed,
          heading: track.heading,
          classification: track.classification,
          probUAV: track.probUAV ?? (track.classification === 'drone' ? 0.9 : 0.1),
          confidence: track.confidence,
          lastUpdated: now,
          firstSeen: track.createdAt,
          detectionCount: Math.round((now - track.createdAt) / 500) + 1,
          isConfirmed: true,
        };
        processNewTrack(fusedTrk);
      });

    }, TICK_MS);

    return () => {
      clearInterval(interval);
      simTracksRef.current.clear();
    };
  }, [isSimulationMode, radars, processNewDetection]);

  const handleTogglePower = (id: number) => {
    const targetRadar = radars.find(r => r.id === id);
    if (!targetRadar) return;
    const newState = !targetRadar.isActive;
    setRadars(radars.map(r => r.id === id ? { ...r, isActive: newState } : r));
    if (!isSimulationMode && wsRef.current?.readyState === WebSocket.OPEN) {
      // Always send fresh configure first so server has updated radar config
      wsRef.current.send(JSON.stringify({ action: 'configure', radars }));
      wsRef.current.send(JSON.stringify({ action: newState ? 'turnOn' : 'turnOff', radarId: id }));
      // Immediately show 'connecting' or 'off' in the UI without waiting for server
      if (newState) {
        setRadarStatuses(prev => ({ ...prev, [id]: 'connecting' }));
      } else {
        setRadarStatuses(prev => ({ ...prev, [id]: 'disconnected' }));
      }
    }
  };

  const handleMasterPower = () => {
    const anyOff = radars.some(r => !r.isActive);
    setRadars(radars.map(r => ({ ...r, isActive: anyOff })));
    if (!isSimulationMode && wsRef.current?.readyState === WebSocket.OPEN) {
      radars.forEach(r => {
        wsRef.current?.send(JSON.stringify({ action: anyOff ? "turnOn" : "turnOff", radarId: r.id }));
      });
    }
  };

  const handleCenterSelected = () => {
    if (currentSelectedDetection && mapRef.current) {
      mapRef.current.flyTo({ center: [currentSelectedDetection.lng, currentSelectedDetection.lat], duration: 1000 });
    }
  };

  const handleDeleteSelected = () => {
    if (!selectedDetection) return;
    const idToDelete = selectedDetection.id;
    // Delete from detections
    setIgnoredDetections(prev => new Set(prev).add(idToDelete));
    setDetections(prev => prev.filter(d => d.id !== idToDelete));
    setTrackHistory(prev => { const n = { ...prev }; delete n[idToDelete]; return n; });
    // Also delete from tracks if it matches a track ID
    setIgnoredTracks(prev => new Set(prev).add(idToDelete));
    setTracks(prev => prev.filter(t => t.id !== idToDelete));
    setTrackHistory_fused(prev => { const n = { ...prev }; delete n[idToDelete]; return n; });
    setSelectedDetection(null);
  };

  const updateRadarConfig = (field: keyof RadarConfig, value: any) => {
    let parsedValue = value;
    if (typeof value === 'string' && value !== '' && value !== '-') {
      const num = parseFloat(value);
      if (!isNaN(num)) {
        parsedValue = num;
      }
    }
    const updatedRadars = radars.map(r => r.id === selectedRadarId ? { ...r, [field]: parsedValue } : r);
    setRadars(updatedRadars);
    if (!isSimulationMode && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ action: 'configure', radars: updatedRadars }));
    }
  };

  // Playback loader effect
  useEffect(() => {
    if (!selectedPlaybackFile || appMode !== 'playback') {
      setPlaybackPackets([]);
      setPlaybackTime(0);
      setPlaybackDuration(0);
      setIsPlaying(false);
      setDetections([]);
      return;
    }

    const loadPlaybackFile = async () => {
      try {
        const response = await fetch(`/api/recordings/download_fused/${selectedPlaybackFile}`);
        const text = await response.text();
        const lines = text.split('\n').filter(Boolean);
        const parsed = lines.map(line => JSON.parse(line));
        
        setPlaybackPackets(parsed);
        if (parsed.length > 0) {
          const maxTime = parsed[parsed.length - 1].timestamp;
          setPlaybackDuration(maxTime);
          setPlaybackTime(0);
          setIsPlaying(false);
          setDetections([]);
        } else {
          setPlaybackDuration(0);
          setPlaybackTime(0);
          setIsPlaying(false);
          alert(lang === 'he' ? 'קובץ ההקלטה ריק' : 'Recording file is empty');
        }
      } catch (e: any) {
        alert(lang === 'he' ? 'שגיאה בטעינת קובץ ההקלטה: ' + e.message : 'Error loading playback file: ' + e.message);
      }
    };

    loadPlaybackFile();
  }, [selectedPlaybackFile, appMode]);

  // Sync refs for playback state to prevent stale closure inside requestAnimationFrame loop
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  
  const playbackTimeRef = useRef(playbackTime);
  useEffect(() => { playbackTimeRef.current = playbackTime; }, [playbackTime]);

  const playbackSpeedRef = useRef(playbackSpeed);
  useEffect(() => { playbackSpeedRef.current = playbackSpeed; }, [playbackSpeed]);

  const playbackDurationRef = useRef(playbackDuration);
  useEffect(() => { playbackDurationRef.current = playbackDuration; }, [playbackDuration]);

  const playbackPacketsRef = useRef(playbackPackets);
  useEffect(() => { playbackPacketsRef.current = playbackPackets; }, [playbackPackets]);

  // Main playback tick logic
  const updateDetectionsForTime = useCallback((timeMs: number) => {
    const packets = playbackPacketsRef.current;
    if (packets.length === 0) return;

    // Use current fade threshold
    const fadeMs = selectedRadar.fadeThreshold * 1000;
    
    // Optimization: find the current index for timeMs using binary search
    let right = packets.length - 1;
    let left = 0;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (packets[mid].timestamp <= timeMs) left = mid + 1;
      else right = mid - 1;
    }
    const endIdx = right; // last packet <= timeMs

    const activeDets: Record<string, Detection> = {};
    const activeTracks: Record<string, FusedTrack> = {};
    const imus: Record<number, any> = {};

    const minTime = timeMs - Math.max(fadeMs, 5000); // look back up to fadeMs or 5s for IMU

    for (let i = endIdx; i >= 0; i--) {
      const entry = packets[i];
      if (entry.timestamp < minTime) break; // Stop when outside the lookback window

      const p = entry.packet;
      if (!p) continue;

      if (p.type === 'imu') {
        if (!imus[p.radarId]) imus[p.radarId] = { ...p, timestamp: entry.timestamp };
      } else if (p.id) {
        if (entry.timestamp > timeMs - fadeMs) {
          if (p.type === 'track') {
            if (!activeTracks[p.id]) activeTracks[p.id] = { ...p, lastUpdated: entry.timestamp };
          } else {
            if (!activeDets[p.id]) activeDets[p.id] = { ...p, lastUpdated: entry.timestamp };
          }
        }
      }
    }

    // Map the relative timestamp to standard Date.now() representation so rendering matches normal logic
    const mappedDets = Object.values(activeDets).map(d => ({
      ...d,
      lastUpdated: Date.now() - (timeMs - d.lastUpdated)
    }));

    const mappedTracks = Object.values(activeTracks).map(t => ({
      ...t,
      lastUpdated: Date.now() - (timeMs - t.lastUpdated)
    }));

    const activeTrackIds = new Set(mappedTracks.map(t => t.id));

    // Single atomic state update — avoids N intermediate renders
    setDetections(mappedDets);
    setTracks(() => {
      // Note: backend generated tracks are named TRK-..., so we replace them all for playback.
      // Wait, if it's playback mode, we just use mappedTracks!
      return mappedTracks;
    });
    setTrackHistory_fused(prev => {
      const next = { ...prev };
      // Remove history for expired tracks
      Object.keys(next).forEach(k => {
        if (!activeTrackIds.has(k)) delete next[k];
      });
      // Append current position for each active track only if it moved
      mappedTracks.forEach(t => {
        const existing = next[t.id] || [];
        const cutoff = Date.now() - 60000;
        const lastPoint = existing[existing.length - 1];
        if (!lastPoint || lastPoint.pos[0] !== t.lng || lastPoint.pos[1] !== t.lat) {
          next[t.id] = [
            ...existing.filter(p => p.time > cutoff),
            { pos: [t.lng, t.lat] as [number, number], time: Date.now() }
          ];
        } else {
          next[t.id] = existing.filter(p => p.time > cutoff);
        }
      });
      return next;
    });
    // ─────────────────────────────────────────────────────────────────────────

    // Sync live IMU data
    const imuData: any = {};
    Object.keys(imus).forEach(rid => {
      const parsedId = parseInt(rid, 10);
      imuData[parsedId] = { pitch: imus[parsedId].pitch, roll: imus[parsedId].roll, yaw: imus[parsedId].yaw };
    });
    setLiveImuData(imuData);
  }, [selectedRadar.fadeThreshold]);

  useEffect(() => {
    if (appMode !== 'playback') return;
    if (!isPlaying) return;

    let lastRealTime = performance.now();
    let frameId: number;

    const tick = () => {
      const now = performance.now();
      const dt = now - lastRealTime;
      lastRealTime = now;

      let nextTime = playbackTimeRef.current + dt * playbackSpeedRef.current;
      if (nextTime >= playbackDurationRef.current) {
        nextTime = playbackDurationRef.current;
        setIsPlaying(false);
      }

      setPlaybackTime(nextTime);
      updateDetectionsForTime(nextTime);

      if (nextTime < playbackDurationRef.current && isPlayingRef.current) {
        frameId = requestAnimationFrame(tick);
      }
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [appMode, isPlaying, updateDetectionsForTime]);

  const handleSeek = (timeMs: number) => {
    setPlaybackTime(timeMs);
    updateDetectionsForTime(timeMs);
  };


  const onMapClick = useCallback((e: any) => {
    if (isSelectingLocationFromMap && selectedRadarId) {
      const { lng, lat } = e.lngLat;
      setRadars(prev => prev.map(r => {
        if (r.id === selectedRadarId) {
          return {
            ...r,
            homeLocation: [lat, lng, r.homeLocation[2]]
          };
        }
        return r;
      }));
      setIsSelectingLocationFromMap(false);
      setShowConfigModal(true);
    } else if (isDrawingZone) {
      setCurrentDrawPolygon(prev => [...prev, [e.lngLat.lng, e.lngLat.lat]]);
    } else if (isDrawingDefenseZone) {
      setCurrentDrawDefensePolygon(prev => [...prev, [e.lngLat.lng, e.lngLat.lat]]);
    }
  }, [isSelectingLocationFromMap, selectedRadarId, isDrawingZone, isDrawingDefenseZone]);
  
  const onMouseMove = useCallback((e: any) => {
    if (mapRef.current) {
      const map = mapRef.current.getMap();
      let elevation = 0;
      if (map.queryTerrainElevation) {
        elevation = map.queryTerrainElevation([e.lngLat.lng, e.lngLat.lat]) || 0;
      }
      setMouseInfo({ lng: e.lngLat.lng, lat: e.lngLat.lat, elevation });
    }
  }, []);

  const finishDrawing = () => {
    if (currentDrawPolygon.length < 3) {
      alert("A polygon must have at least 3 points");
      return;
    }
    const nextNum = String(ignoreZones.length + 1).padStart(3, '0');
    setNewZoneName(`אזור-${nextNum}`);
    setIsDrawingZone(false);
    setShowZoneHeightDialog(true);
  };

  const saveIgnoreZone = () => {
    const newZone: IgnoreZone = {
      id: `zone-${Date.now()}`,
      name: newZoneName.trim() || `אזור-${String(ignoreZones.length + 1).padStart(3, '0')}`,
      type: 'polygon',
      coordinates: [...currentDrawPolygon, currentDrawPolygon[0]],
      minAgl: newZoneHeights.minAgl,
      maxAgl: newZoneHeights.maxAgl
    };
    setIgnoreZones([...ignoreZones, newZone]);
    setCurrentDrawPolygon([]);
    setNewZoneName('');
    setShowZoneHeightDialog(false);
  };

  const finishDrawingDefenseZone = () => {
    if (currentDrawDefensePolygon.length < 3) {
      alert("A polygon must have at least 3 points");
      return;
    }
    const nextNum = String(defenseZones.length + 1).padStart(3, '0');
    setNewDefenseZoneName(lang === 'he' ? `מרחב-${nextNum}` : `Zone-${nextNum}`);
    setIsDrawingDefenseZone(false);
    setShowDefenseZoneDialog(true);
  };

  const saveDefenseZone = () => {
    const newZone: DefenseZone = {
      id: `defense-${Date.now()}`,
      name: newDefenseZoneName.trim() || `מרחב-${String(defenseZones.length + 1).padStart(3, '0')}`,
      coordinates: [...currentDrawDefensePolygon, currentDrawDefensePolygon[0]],
      color: '#3B82F6' // default blue
    };
    setDefenseZones([...defenseZones, newZone]);
    setCurrentDrawDefensePolygon([]);
    setNewDefenseZoneName('');
    setShowDefenseZoneDialog(false);
  };


  const combinedRadarSectorsGeoJson = useMemo(() => {
    const features: any[] = [];
    radars.forEach(radar => {
      if (!radar.isActive) return;
      const center = turf.point([radar.homeLocation[1], radar.homeLocation[0]]); 
      const radius = 0.75; 
      const options = { steps: 64, units: 'kilometers' as const };
      const bearing1 = radar.heading + radar.azFovMin;
      const bearing2 = radar.heading + radar.azFovMax;
      try {
        const sector = turf.sector(center, radius, bearing1, bearing2, options);
        sector.properties = { radarId: radar.id, isSelected: radar.id === selectedRadarId };
        features.push(sector);
      } catch(e) {}
    });
    return features.length ? turf.featureCollection(features) : null;
  }, [radars, selectedRadarId]);


  const getStatusColor = (radar: RadarConfig) => {
    // In simulation mode: gray=off, green=on (simulated)
    if (isSimulationMode) {
      return radar.isActive ? '#10B981' : '#4B5563';
    }
    // In live mode: use radarStatuses from server messages
    if (!radar.isActive) return '#4B5563';  // gray = powered off
    const rStatus = radarStatuses[radar.id];
    if (rStatus === 'connected')    return '#10B981'; // green  = radar confirmed healthy
    if (rStatus === 'connecting')   return '#FBBF24'; // yellow = daemon starting / handshake
    if (rStatus === 'error')        return '#EF4444'; // red    = error from daemon
    if (rStatus === 'disconnected') return '#4B5563'; // gray   = explicitly turned off
    // isActive=true but no status yet → just turned on, waiting for daemon
    return '#FBBF24'; // yellow = in progress
  };

  const filteredDetections = detections.filter(d => {
    const classification = getClassification(d);
    let reason = '';
    if (ignoredDetections.has(d.id)) reason = 'ignored';
    else if (classification === 'drone' && !filters.showDrone) reason = 'drone filter';
    else if (classification === 'unknown' && !filters.showUnknown) reason = 'unknown filter';
    else if (classification === 'bird' && !filters.showBird) reason = 'bird filter';
    else if (d.speed < filters.minSpeed || d.speed > filters.maxSpeed) reason = `speed ${d.speed} out of bounds`;
    else if (d.raw && d.raw.rcs !== undefined && (d.raw.rcs < filters.minRcs || d.raw.rcs > filters.maxRcs)) reason = `rcs ${d.raw.rcs} out of bounds`;
    
    const sourceRadar = radars.find(r => r.id === d.radarId) || selectedRadar;
    const agl = d.alt - (sourceRadar.homeLocation[2] || 0);
    if (!reason && classification !== 'drone' && classification !== 'bird' && (agl < filters.minAgl || agl > filters.maxAgl)) {
      reason = `agl ${agl} out of bounds (${filters.minAgl}-${filters.maxAgl})`;
    }

    if (reason) {
      console.log(`[DEBUG] Filtered out ${d.id}: ${reason}`);
      return false;
    }
    const pt = turf.point([d.lng, d.lat]);
    for (const zone of ignoreZones) {
      if (agl >= zone.minAgl && agl <= zone.maxAgl) {
        if (zone.type === 'polygon' && zone.coordinates.length >= 4) {
          const poly = turf.polygon([zone.coordinates]);
          if (turf.booleanPointInPolygon(pt, poly)) return false;
        } else if (zone.type === 'circle' && zone.radius) {
          const center = turf.point(zone.coordinates[0]);
          const distance = turf.distance(center, pt, { units: 'meters' });
          if (distance <= zone.radius) return false;
        }
      }
    }

    return true;
  });

  // Fused tracks filter — same logic applied to Track layer
  const filteredTracks = tracks.filter(tr => {
    if (ignoredTracks.has(tr.id)) return false;
    const classification = getClassification(tr as any);
    if (classification === 'drone' && !filters.showDrone) return false;
    if (classification === 'unknown' && !filters.showUnknown) return false;
    if (classification === 'bird' && !filters.showBird) return false;
    if (tr.speed < filters.minSpeed || tr.speed > filters.maxSpeed) return false;
    const agl = tr.alt - (selectedRadar.homeLocation[2] || 0);
    if (classification !== 'drone' && classification !== 'bird' && (agl < filters.minAgl || agl > filters.maxAgl)) return false;
    const pt = turf.point([tr.lng, tr.lat]);
    for (const zone of ignoreZones) {
      if (agl >= zone.minAgl && agl <= zone.maxAgl) {
        if (zone.type === 'polygon' && zone.coordinates.length >= 4) {
          const poly = turf.polygon([zone.coordinates]);
          if (turf.booleanPointInPolygon(pt, poly)) return false;
        } else if (zone.type === 'circle' && zone.radius) {
          const center = turf.point(zone.coordinates[0]);
          const distance = turf.distance(center, pt, { units: 'meters' });
          if (distance <= zone.radius) return false;
        }
      }
    }
    return true;
  });

  // Unified visible items list (detection-shaped) for threat scoring and popups
  const visibleDetections: Detection[] = displayMode === 'tracks'
    ? filteredTracks.map(tr => ({
        id: tr.id, radarId: (tr.radarIds?.[0] ?? 0), lat: tr.lat, lng: tr.lng, alt: tr.alt,
        classification: tr.classification, confidence: tr.confidence, speed: tr.speed,
        heading: tr.heading, lastUpdated: tr.lastUpdated, probUAV: tr.probUAV, raw: tr.raw
      } as Detection))
    : displayMode === 'both'
    ? [
        ...filteredDetections,
        ...filteredTracks.map(tr => ({
          id: tr.id, radarId: (tr.radarIds?.[0] ?? 0), lat: tr.lat, lng: tr.lng, alt: tr.alt,
          classification: tr.classification, confidence: tr.confidence, speed: tr.speed,
          heading: tr.heading, lastUpdated: tr.lastUpdated, probUAV: tr.probUAV, raw: tr.raw
        } as Detection))
      ]
    : filteredDetections;

  // Threat alert check loop
  useEffect(() => {
    const activeIds = new Set(visibleDetections.map(d => d.id));
    const currentThreats = visibleDetections.filter(d => {
      const score = defenseZones.length > 0 
        ? computeThreatScore(d, defenseZones, threatWeights).score
        : (getClassification(d) === 'drone' ? 1.0 : 0.0);
      return score >= alertThreshold;
    });

    // 1. Process new threats (sound & focus)
    currentThreats.forEach(t => {
      if (!focusedThreatIdsRef.current.has(t.id)) {
        setSelectedDetection(t);
        if (mapRef.current) {
          mapRef.current.flyTo({ center: [t.lng, t.lat], zoom: 15, duration: 1000 });
        }
        focusedThreatIdsRef.current.add(t.id);
        playAlertSound();
      }
    });

    // 2. Cleanup focusedThreatIdsRef for targets that disappeared
    focusedThreatIdsRef.current.forEach(id => {
      if (!activeIds.has(id)) {
        focusedThreatIdsRef.current.delete(id);
      }
    });

    // 3. Update alertPopups state
    setAlertPopups(prev => {
      const now = Date.now();
      let updated = [...prev];

      // Update existing popups with live data or mark them offline if target disappeared
      updated = updated.map(p => {
        const activeDet = visibleDetections.find(d => d.id === p.id);
        if (activeDet) {
          const score = defenseZones.length > 0 
            ? computeThreatScore(activeDet, defenseZones, threatWeights).score
            : (getClassification(activeDet) === 'drone' ? 1.0 : 0.0);
          return {
            ...p,
            score,
            alt: activeDet.alt,
            lng: activeDet.lng,
            lat: activeDet.lat,
            speed: activeDet.speed,
            isOffline: false
          };
        } else {
          return { ...p, isOffline: true };
        }
      });

      // Add new threat alerts if not already in the popup list and not recently closed
      currentThreats.forEach(t => {
        if (!updated.some(p => p.id === t.id) && !closedThreatAlertIds.has(t.id)) {
          const score = defenseZones.length > 0 
            ? computeThreatScore(t, defenseZones, threatWeights).score
            : (getClassification(t) === 'drone' ? 1.0 : 0.0);
          updated.push({
            id: t.id,
            score,
            alt: t.alt,
            lng: t.lng,
            lat: t.lat,
            speed: t.speed,
            timestamp: now,
            isOffline: false
          });
        }
      });

      // Filter out popups according to duration setting
      updated = updated.filter(p => {
        if (closedThreatAlertIds.has(p.id)) return false;

        if (alertPopupDuration === 0) {
          return !p.isOffline;
        }

        if (alertPopupDuration > 0) {
          const elapsedSeconds = (now - p.timestamp) / 1000;
          return elapsedSeconds < alertPopupDuration;
        }

        return true; // if -1, keep forever
      });

      return updated;
    });

    // Clean up closed alerts set for targets that disappeared so they can trigger again next time
    setClosedThreatAlertIds(prev => {
      const updated = new Set(prev);
      let changed = false;
      prev.forEach(id => {
        if (!activeIds.has(id)) {
          updated.delete(id);
          changed = true;
        }
      });
      return changed ? updated : prev;
    });

  }, [visibleDetections, defenseZones, threatWeights, alertThreshold, alertPopupDuration, getClassification, playAlertSound, closedThreatAlertIds]);

  const masterPowerActive = radars.some(r => r.isActive);
  const currentSelectedDetection = selectedDetection 
    ? visibleDetections.find(d => d.id === selectedDetection.id) || null 
    : null;

  const trailsGeoJson = useMemo(() => {
    const features: any[] = [];
    const cutoff = Date.now() - (filters.trailLengthSeconds * 1000);
    
    if (displayMode !== 'tracks') {
      filteredDetections.forEach(d => {
        const history = trackHistory[d.id];
        if (history) {
          const validHistory = history.filter(p => p.time >= cutoff);
          if (validHistory.length >= 2) {
            features.push({ ...turf.lineString(validHistory.map(p => p.pos)), properties: { isFused: false } });
          }
        }
      });
    }

    if (displayMode !== 'detections') {
      filteredTracks.forEach(tr => {
        const history = trackHistory_fused[tr.id];
        if (history) {
          const validHistory = history.filter(p => p.time >= cutoff);
          if (validHistory.length >= 2) {
            features.push({ ...turf.lineString(validHistory.map(p => p.pos)), properties: { isFused: true } });
          }
        }
      });
    }
    
    if (features.length === 0) return null;
    return turf.featureCollection(features);
  }, [displayMode, filteredDetections, filteredTracks, trackHistory, trackHistory_fused, filters.trailLengthSeconds]);

  // Dynamic Map Style based on user choice
  const mapStyleMemo = useMemo(() => {
    const rasterUrl = mapType === 'dark'
      ? 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'
      : 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

    return {
      version: 8,
      sources: {
        basemap: {
          type: 'raster',
          tiles: [rasterUrl],
          tileSize: 256,
          attribution: 'Map tiles by Carto, ArcGIS, OpenStreetMap',
        },
        terrainSource: {
          type: 'raster-dem',
          tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 14
        }
      },
      layers: [
        {
          id: 'basemap-layer',
          type: 'raster',
          source: 'basemap',
          minzoom: 0,
          maxzoom: 19
        }
      ],
      terrain: { source: 'terrainSource', exaggeration: 1 }
    };
  }, [mapType]);

  return (
    <div className="overlay-container" style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      
      {/* 3D MAP */}
      <Map
        ref={mapRef}
        {...viewState}
        onMove={evt => setViewState(evt.viewState)}
        onClick={onMapClick}
        onMouseMove={onMouseMove}
        style={{ width: '100%', height: '100%', position: 'absolute' }}
        mapStyle={mapStyleMemo as any}
        maxPitch={0}
        cursor={(isDrawingZone || isDrawingDefenseZone) ? 'crosshair' : 'grab'}
      >
        <NavigationControl position="top-left" style={{ marginTop: '90px' }} />

        {/* Radar Footprints (Combined Source for stability) */}
        {combinedRadarSectorsGeoJson && (
          <Source id="radar-sectors" type="geojson" data={combinedRadarSectorsGeoJson}>
            <Layer 
              id="radar-sectors-fill" 
              type="fill" 
              paint={{
                'fill-color': ['case', ['boolean', ['get', 'isSelected'], false], '#00E5FF', '#4ade80'],
                'fill-opacity': 0.15,
                'fill-outline-color': ['case', ['boolean', ['get', 'isSelected'], false], '#00E5FF', '#4ade80']
              }} 
            />
          </Source>
        )}

        {/* Radar Markers */}
        {radars.map(radar => (
          <Marker
            key={`radar-marker-${radar.id}`}
            longitude={radar.homeLocation[1]}
            latitude={radar.homeLocation[0]}
            color="#4ade80"
            draggable={true}
            onDragEnd={(evt) => handleRadarDragEnd(radar.id, evt)}
          />
        ))}

        {/* Saved Ignore Zones */}
        {ignoreZones.map(zone => {
          if (zone.type === 'polygon') {
            const polyGeoJson = turf.polygon([zone.coordinates]);
            return (
              <Source key={zone.id} id={`ignore-${zone.id}`} type="geojson" data={polyGeoJson}>
                <Layer type="fill" paint={{ 'fill-color': '#EF4444', 'fill-opacity': 0.3 }} />
                <Layer type="line" paint={{ 'line-color': '#EF4444', 'line-width': 2 }} />
              </Source>
            );
          }
          return null;
        })}

        {/* Saved Defense Zones */}
        {defenseZones.map(zone => {
          const polyGeoJson = turf.polygon([zone.coordinates]);
          return (
            <Source key={zone.id} id={`defense-src-${zone.id}`} type="geojson" data={polyGeoJson}>
              <Layer type="fill" paint={{ 'fill-color': zone.color || '#3B82F6', 'fill-opacity': 0.25 }} />
              <Layer type="line" paint={{ 'line-color': zone.color || '#3B82F6', 'line-width': 2.5 }} />
            </Source>
          );
        })}

        {/* Current Drawing Polygon */}
        {isDrawingZone && currentDrawPolygon.length > 0 && (
          <Source id="draw-poly" type="geojson" data={
            currentDrawPolygon.length >= 3 
              ? turf.polygon([[...currentDrawPolygon, currentDrawPolygon[0]]])
              : currentDrawPolygon.length === 2 
                ? turf.lineString(currentDrawPolygon)
                : turf.point(currentDrawPolygon[0])
          }>
            {currentDrawPolygon.length >= 3 && <Layer id="draw-fill" type="fill" paint={{ 'fill-color': '#EF4444', 'fill-opacity': 0.4 }} />}
            {currentDrawPolygon.length >= 2 && <Layer id="draw-line" type="line" paint={{ 'line-color': '#EF4444', 'line-width': 3 }} />}
            <Layer id="draw-pts" type="circle" paint={{ 'circle-color': '#EF4444', 'circle-radius': 5 }} />
          </Source>
        )}

        {/* Current Drawing Defense Polygon */}
        {isDrawingDefenseZone && currentDrawDefensePolygon.length > 0 && (
          <Source id="draw-defense-poly" type="geojson" data={
            currentDrawDefensePolygon.length >= 3 
              ? turf.polygon([[...currentDrawDefensePolygon, currentDrawDefensePolygon[0]]])
              : currentDrawDefensePolygon.length === 2 
                ? turf.lineString(currentDrawDefensePolygon)
                : turf.point(currentDrawDefensePolygon[0])
          }>
            {currentDrawDefensePolygon.length >= 3 && <Layer id="draw-defense-fill" type="fill" paint={{ 'fill-color': '#3B82F6', 'fill-opacity': 0.4 }} />}
            {currentDrawDefensePolygon.length >= 2 && <Layer id="draw-defense-line" type="line" paint={{ 'line-color': '#3B82F6', 'line-width': 3 }} />}
            <Layer id="draw-defense-pts" type="circle" paint={{ 'circle-color': '#3B82F6', 'circle-radius': 5 }} />
          </Source>
        )}

        {/* Trails — detections (amber) and fused tracks (cyan, thicker) */}
        {trailsGeoJson && (
          <Source id="trails-source" type="geojson" data={trailsGeoJson}>
            {/* Raw detection trails — amber */}
            <Layer id="trails-layer-det" type="line"
              filter={['!', ['boolean', ['get', 'isFused'], false]]}
              paint={{ 'line-color': '#FBBF24', 'line-width': 3, 'line-opacity': 0.8 }} />
            {/* Fused track trails — cyan, thicker */}
            <Layer id="trails-layer-trk" type="line"
              filter={['boolean', ['get', 'isFused'], false]}
              paint={{ 'line-color': '#00E5FF', 'line-width': 4.5, 'line-opacity': 0.9 }} />
          </Source>
        )}

        {/* Raw Detection Markers */}
        {displayMode !== 'tracks' && filteredDetections.map(d => {
          const isSelected = currentSelectedDetection?.id === d.id;
          const classification = getClassification(d);
          const aglMeters = getTerrainAgl(d.lng, d.lat, d.alt);
          
          let color = 'var(--accent-orange)';
          if (defenseZones.length > 0) {
            const { score } = computeThreatScore(d, defenseZones, threatWeights);
            color = getThreatColor(score);
          } else {
            if (classification === 'drone') color = 'var(--accent-red)';
            else if (classification === 'bird') color = '#10B981';
          }

          return (
            <Marker 
              key={d.id} 
              longitude={d.lng} latitude={d.lat} 
              onClick={(e) => { e.originalEvent.stopPropagation(); setSelectedDetection(d); }}
            >
              <div
                className={isSelected ? 'icon-selected' : ''}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', transform: `rotate(${d.heading}deg) ${isSelected ? 'scale(1.2)' : 'scale(1)'}`, color, transition: 'all 0.2s', cursor: 'pointer' }}
              >
                {classification === 'drone' && (
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 4px rgba(0,0,0,0.6))' }}>
                    <circle cx="12" cy="12" r="3" fill="currentColor"/>
                    <path d="M6 6l12 12M18 6L6 18" />
                    <circle cx="5" cy="5" r="2.2" />
                    <circle cx="19" cy="5" r="2.2" />
                    <circle cx="5" cy="19" r="2.2" />
                    <circle cx="19" cy="19" r="2.2" />
                  </svg>
                )}
                {classification === 'unknown' && (
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 4px rgba(0,0,0,0.6))' }}>
                    <path d="M8 10c0-3 2-4 4-4s4 1 4 4" fill="currentColor" fillOpacity="0.3"/>
                    <ellipse cx="12" cy="12" rx="9" ry="3.5"/>
                    <path d="M5 14.5c0 0 2 1.5 7 1.5s7-1.5 7-1.5" />
                    <circle cx="9" cy="12" r="0.8" fill="currentColor"/>
                    <circle cx="12" cy="12" r="0.8" fill="currentColor"/>
                    <circle cx="15" cy="12" r="0.8" fill="currentColor"/>
                  </svg>
                )}
                {classification === 'bird' && (
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 4px rgba(0,0,0,0.5))' }}>
                    <path d="M3 10c4-4 8-4 10-1 2-3 6-3 10 1-4 2-8 1-10-2-2 3-6 4-10 2z"/>
                    <path d="M12 9v4"/>
                  </svg>
                )}
                {/* AGL label */}
                <div style={{
                  transform: `rotate(${-d.heading}deg)`,
                  marginTop: '2px',
                  background: 'rgba(0,0,0,0.75)',
                  color: '#fff',
                  fontSize: '10px',
                  fontWeight: 'bold',
                  padding: '1px 4px',
                  borderRadius: '3px',
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                  letterSpacing: '0.3px',
                }}>
                  ↑ {aglMeters}m
                </div>
              </div>
            </Marker>
          );
        })}

        {/* Fused Track Markers — double-ring visual */}
        {displayMode !== 'detections' && filteredTracks.map(tr => {
          const trAsDet: Detection = {
            id: tr.id, radarId: tr.radarIds?.[0] ?? 0, lat: tr.lat, lng: tr.lng, alt: tr.alt,
            classification: tr.classification, confidence: tr.confidence, speed: tr.speed,
            heading: tr.heading, lastUpdated: tr.lastUpdated, probUAV: tr.probUAV, raw: tr.raw
          };
          const isSelected = currentSelectedDetection?.id === tr.id;
          const classification = getClassification(trAsDet);
          const aglMeters = getTerrainAgl(tr.lng, tr.lat, tr.alt);

          let color = '#00E5FF'; // cyan base for tracks
          if (defenseZones.length > 0) {
            const { score } = computeThreatScore(trAsDet, defenseZones, threatWeights);
            color = getThreatColor(score);
          } else {
            if (classification === 'drone') color = '#FF6B6B';
            else if (classification === 'bird') color = '#34D399';
          }

          const multiRadar = (tr.radarIds?.length ?? 1) > 1;

          return (
            <Marker
              key={tr.id}
              longitude={tr.lng} latitude={tr.lat}
              onClick={(e) => { e.originalEvent.stopPropagation(); setSelectedDetection(trAsDet); }}
            >
              <div
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  transform: `rotate(${tr.heading}deg) ${isSelected ? 'scale(1.25)' : 'scale(1)'}`,
                  opacity: (tr as any).isPrediction ? 0.5 : 1,
                  transition: 'all 0.2s', cursor: 'pointer'
                }}
              >
                {/* Double-ring icon */}
                <div style={{ position: 'relative', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {/* Outer ring */}
                  <div style={{
                    position: 'absolute', width: 40, height: 40, borderRadius: '50%',
                    border: (tr as any).isPrediction ? `2px dashed ${color}` : `2px solid ${color}`, opacity: 0.5,
                    boxShadow: `0 0 8px ${color}55`
                  }} />
                  {/* Inner icon */}
                  <div style={{ color, filter: `drop-shadow(0 0 6px ${color})` }}>
                    {classification === 'drone' && (
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="3" fill="currentColor"/>
                        <path d="M6 6l12 12M18 6L6 18" />
                        <circle cx="5" cy="5" r="2" />
                        <circle cx="19" cy="5" r="2" />
                        <circle cx="5" cy="19" r="2" />
                        <circle cx="19" cy="19" r="2" />
                      </svg>
                    )}
                    {classification === 'unknown' && (
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <ellipse cx="12" cy="12" rx="9" ry="3.5"/>
                        <path d="M5 14.5c0 0 2 1.5 7 1.5s7-1.5 7-1.5"/>
                        <circle cx="9" cy="12" r="0.8" fill="currentColor"/>
                        <circle cx="12" cy="12" r="0.8" fill="currentColor"/>
                        <circle cx="15" cy="12" r="0.8" fill="currentColor"/>
                      </svg>
                    )}
                    {classification === 'bird' && (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 10c4-4 8-4 10-1 2-3 6-3 10 1-4 2-8 1-10-2-2 3-6 4-10 2z"/>
                        <path d="M12 9v4"/>
                      </svg>
                    )}
                  </div>
                  {/* Multi-radar badge */}
                  {multiRadar && (
                    <div style={{
                      position: 'absolute', top: -4, right: -4,
                      background: '#FFD700', color: '#000',
                      borderRadius: '50%', width: 14, height: 14,
                      fontSize: '9px', fontWeight: 'bold',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transform: `rotate(${-tr.heading}deg)`
                    }}>{tr.radarIds.length}</div>
                  )}
                </div>
                {/* TRK label + AGL */}
                <div style={{
                  transform: `rotate(${-tr.heading}deg)`,
                  marginTop: '2px',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px',
                  pointerEvents: 'none'
                }}>
                  <div style={{
                    background: color, color: '#000',
                    fontSize: '9px', fontWeight: '900',
                    padding: '1px 5px', borderRadius: '3px',
                    letterSpacing: '0.5px', whiteSpace: 'nowrap'
                  }}>{tr.id}</div>
                  <div style={{
                    background: 'rgba(0,0,0,0.8)', color: '#fff',
                    fontSize: '10px', fontWeight: 'bold',
                    padding: '1px 4px', borderRadius: '3px', whiteSpace: 'nowrap'
                  }}>↑ {aglMeters}m</div>
                </div>
              </div>
            </Marker>
          );
        })}
      </Map>

      {/* DRAWING MODE OVERLAY */}
      {isDrawingZone && (
        <div style={{ position: 'absolute', top: '100px', left: '50%', transform: 'translateX(-50%)', background: 'var(--accent-red)', padding: '1rem', borderRadius: '8px', zIndex: 1001, display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <span style={{ fontWeight: 'bold' }}>{t.drawModeMsg}</span>
          <button onClick={() => { setIsDrawingZone(false); setCurrentDrawPolygon([]); }} style={{ background: '#fff', color: '#000', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }}>{t.cancelDraw}</button>
          <button onClick={finishDrawing} style={{ background: '#000', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer', display: 'flex', gap: '4px' }}><Check size={16}/> {t.finish}</button>
        </div>
      )}

      {isDrawingDefenseZone && (
        <div style={{ position: 'absolute', top: '100px', left: '50%', transform: 'translateX(-50%)', background: 'var(--accent-cyan)', color: '#000', padding: '1rem', borderRadius: '8px', zIndex: 1001, display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <span style={{ fontWeight: 'bold' }}>{t.drawingDefense}</span>
          <button onClick={() => { setIsDrawingDefenseZone(false); setCurrentDrawDefensePolygon([]); }} style={{ background: '#fff', color: '#000', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }}>{t.cancelDraw}</button>
          <button onClick={finishDrawingDefenseZone} style={{ background: '#000', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer', display: 'flex', gap: '4px' }}><Check size={16}/> {t.finish}</button>
        </div>
      )}

      {isSelectingLocationFromMap && (
        <div style={{ position: 'absolute', top: '100px', left: '50%', transform: 'translateX(-50%)', background: 'var(--accent-cyan)', color: '#000', padding: '1rem', borderRadius: '8px', zIndex: 1001, display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <span style={{ fontWeight: 'bold' }}>
            {lang === 'he' ? 'אנא לחץ על המפה לבחירת מיקום המכ"ם החדש' : 'Please click on the map to select the new radar location'}
          </span>
          <button onClick={() => { setIsSelectingLocationFromMap(false); setShowConfigModal(true); }} style={{ background: '#fff', color: '#000', border: 'none', padding: '0.5rem 1rem', borderRadius: '4px', cursor: 'pointer' }}>
            {t.cancelDraw}
          </button>
        </div>
      )}

      {/* Active Threat Popups Stack */}
      <div style={{
        position: 'absolute',
        top: '100px',
        right: '20px',
        zIndex: 10002,
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        width: '320px',
        pointerEvents: 'none'
      }}>
        {alertPopups.map(threat => {
          return (
            <div 
              key={`alert-popup-${threat.id}`}
              className="glass-panel pulse-alert-border"
              style={{
                pointerEvents: 'auto',
                background: threat.isOffline ? 'rgba(20, 20, 20, 0.9)' : 'rgba(20, 5, 5, 0.9)',
                border: threat.isOffline ? '2px solid #555' : '2px solid var(--accent-red)',
                borderRadius: '8px',
                padding: '1rem',
                boxShadow: threat.isOffline ? 'none' : '0 0 15px rgba(239, 68, 68, 0.4)',
                color: '#fff',
                textAlign: lang === 'he' ? 'right' : 'left',
                direction: lang === 'he' ? 'rtl' : 'ltr'
              }}
            >
              <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'center', borderBottom: threat.isOffline ? '1px solid #555' : '1px solid rgba(239, 68, 68, 0.3)', paddingBottom: '0.5rem', marginBottom: '0.5rem' }}>
                <div className="flex-row" style={{ alignItems: 'center', gap: '8px' }}>
                  {!threat.isOffline && <span className="blink-dot" style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--accent-red)' }} />}
                  <strong style={{ color: threat.isOffline ? '#aaa' : 'var(--accent-red)', fontSize: '0.95rem' }}>
                    {threat.isOffline 
                      ? (lang === 'he' ? 'איום לא מקוון / אבד קשר' : 'Threat Offline / Connection Lost')
                      : (lang === 'he' ? 'חדירת כלי טיס עוין!' : 'Hostile Aircraft Intrusion!')}
                  </strong>
                </div>
                <button 
                  onClick={() => setClosedThreatAlertIds(prev => {
                    const next = new Set(prev);
                    next.add(threat.id);
                    return next;
                  })} 
                  style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }}
                >
                  &times;
                </button>
              </div>
              <div className="flex-col" style={{ gap: '4px', fontSize: '0.85rem' }}>
                <div><strong>{lang === 'he' ? 'מזהה מטרה:' : 'Target ID:'}</strong> {threat.id}</div>
                <div><strong>{lang === 'he' ? 'רמת איום:' : 'Threat Level:'}</strong> <span style={{ color: threat.isOffline ? '#aaa' : 'var(--accent-red)', fontWeight: 'bold' }}>{Math.round(threat.score * 100)}%</span></div>
                <div><strong>{lang === 'he' ? 'גובה מעפ"ש:' : 'AGL Altitude:'}</strong> {getTerrainAgl(threat.lng, threat.lat, threat.alt)}m</div>
                <div><strong>{lang === 'he' ? 'מהירות:' : 'Speed:'}</strong> {threat.speed.toFixed(1)} m/s</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ZONE HEIGHT DIALOG */}
      {showZoneHeightDialog && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-panel" style={{ width: '420px', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldAlert size={22} color="var(--accent-red)" /> {t.configZoneTitle}
            </h2>

            {/* Zone Name */}
            <div className="flex-col">
              <label style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '4px' }}>
                {lang === 'he' ? 'שם האזור' : 'Zone Name'}
              </label>
              <input
                type="text"
                className="config-input"
                value={newZoneName}
                onChange={(e) => setNewZoneName(e.target.value)}
                placeholder={lang === 'he' ? 'שם ברירת מחדל...' : 'Default name...'}
                style={{
                  fontSize: '1rem',
                  fontWeight: 'bold',
                  letterSpacing: '0.5px',
                  borderColor: 'var(--accent-cyan)',
                  boxShadow: '0 0 6px rgba(0,229,255,0.15)'
                }}
                autoFocus
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                {lang === 'he' ? 'שם ברירת מחדל נוצר אוטומטית — ניתן לערוך' : 'Auto-generated default name — editable'}
              </span>
            </div>

            <div className="flex-col">
              <label>{t.minAglLabel}</label>
              <input type="number" className="config-input" value={newZoneHeights.minAgl} onChange={(e) => setNewZoneHeights({...newZoneHeights, minAgl: parseFloat(e.target.value)||0})} />
            </div>
            <div className="flex-col">
              <label>{t.maxAglLabel}</label>
              <input type="number" className="config-input" value={newZoneHeights.maxAgl} onChange={(e) => setNewZoneHeights({...newZoneHeights, maxAgl: parseFloat(e.target.value)||0})} />
            </div>
            <div className="flex-row" style={{ gap: '1rem', marginTop: '0.5rem' }}>
              <button onClick={() => { setShowZoneHeightDialog(false); setCurrentDrawPolygon([]); setNewZoneName(''); }} style={{ flex: 1, padding: '0.5rem', borderRadius: '4px', background: 'transparent', border: '1px solid #fff', color: '#fff', cursor: 'pointer' }}>{t.cancel}</button>
              <button onClick={saveIgnoreZone} style={{ flex: 1, padding: '0.5rem', borderRadius: '4px', background: 'var(--accent-cyan)', border: 'none', color: '#000', fontWeight: 'bold', cursor: 'pointer' }}>{t.saveZone}</button>
            </div>
          </div>
        </div>
      )}

      {/* DEFENSE ZONE DIALOG */}
      {showDefenseZoneDialog && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-panel" style={{ width: '420px', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldAlert size={22} color="var(--accent-cyan)" /> {t.configDefenseZoneTitle}
            </h2>

            {/* Zone Name */}
            <div className="flex-col">
              <label style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '4px' }}>
                {t.zoneNameLabel}
              </label>
              <input
                type="text"
                className="config-input"
                value={newDefenseZoneName}
                onChange={(e) => setNewDefenseZoneName(e.target.value)}
                placeholder={lang === 'he' ? 'שם ברירת מחדל...' : 'Default name...'}
                style={{
                  fontSize: '1rem',
                  fontWeight: 'bold',
                  letterSpacing: '0.5px',
                  borderColor: 'var(--accent-cyan)',
                  boxShadow: '0 0 6px rgba(0,229,255,0.15)'
                }}
                autoFocus
              />
            </div>

            <div className="flex-row" style={{ gap: '1rem', marginTop: '0.5rem' }}>
              <button onClick={() => { setShowDefenseZoneDialog(false); setCurrentDrawDefensePolygon([]); setNewDefenseZoneName(''); }} style={{ flex: 1, padding: '0.5rem', borderRadius: '4px', background: 'transparent', border: '1px solid #fff', color: '#fff', cursor: 'pointer' }}>{t.cancel}</button>
              <button onClick={saveDefenseZone} style={{ flex: 1, padding: '0.5rem', borderRadius: '4px', background: 'var(--accent-cyan)', border: 'none', color: '#000', fontWeight: 'bold', cursor: 'pointer' }}>{t.saveDefense}</button>
            </div>
          </div>
        </div>
      )}


      {/* MOUSE TELEMETRY (Bottom Right) */}
      <div className="glass-panel" style={{ position: 'absolute', bottom: '1rem', right: '1rem', zIndex: 1000, padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
        <div className="flex-row" style={{ gap: '1rem' }}>
          <div><span className="text-muted">{t.latLabel}:</span> {mouseInfo.lat.toFixed(5)}</div>
          <div><span className="text-muted">{t.lngLabel}:</span> {mouseInfo.lng.toFixed(5)}</div>
          <div><span className="text-muted">{t.dtmHeight}:</span> <span style={{ color: 'var(--accent-cyan)', fontWeight: 'bold' }}>{mouseInfo.elevation.toFixed(1)}m</span></div>
        </div>
      </div>

      {/* UI OVERLAYS (Top Bar, Side Panels) */}
      <div className="top-bar glass-panel" style={{ position: 'absolute', top: '1rem', left: '50%', transform: 'translateX(-50%)', zIndex: 1000, display: 'flex', alignItems: 'center' }}>
        <Radar className="text-muted" />
        <h3 style={{ margin: 0, marginLeft: '10px', letterSpacing: '1px', fontWeight: 800 }}>MITZPE METZODA</h3>
        <span style={{ marginLeft: '10px', fontSize: '0.7rem', color: 'var(--accent-cyan)', border: '1px solid var(--accent-cyan)', padding: '2px 4px', borderRadius: '4px', fontWeight: 'bold' }}>v1.2.12</span>
        <div style={{ width: '1px', height: '24px', background: 'rgba(255,255,255,0.2)', margin: '0 1rem' }} />
        
        <button className={`glowing-btn ${masterPowerActive ? 'active' : ''}`} onClick={handleMasterPower} style={{ padding: '0.25rem 0.75rem', borderRadius: '4px', fontSize: '0.85rem', display: 'flex', alignItems: 'center' }}>
          <Power size={14} style={{ marginRight: '6px' }} />
          {masterPowerActive ? t.masterOn : t.masterOff}
        </button>
        <div style={{ width: '1px', height: '24px', background: 'rgba(255,255,255,0.2)', margin: '0 1rem' }} />

        <div className="flex-row">
          {radars.map(r => (
            <button key={r.id} onClick={() => setSelectedRadarId(r.id)} style={{ position: 'relative', background: selectedRadarId === r.id ? 'var(--accent-cyan)' : 'transparent', color: selectedRadarId === r.id ? 'var(--bg-color)' : 'var(--text-primary)', border: '1px solid rgba(255,255,255,0.1)', padding: '0.25rem 0.75rem', borderRadius: '4px', cursor: 'pointer' }}>
              <span 
                style={{
                  position: 'absolute', top: '-4px', right: '-4px', width: '10px', height: '10px',
                  borderRadius: '50%', background: getStatusColor(r), border: '2px solid var(--bg-color)'
                }}
              />
              R{r.id}
            </button>
          ))}
        </div>
        
        <div style={{ width: '1px', height: '24px', background: 'rgba(255,255,255,0.2)', margin: '0 1rem' }} />
        
        {/* APP MODE THREE-WAY SELECTOR */}
        <div className="flex-row" style={{ gap: '0.5rem', background: 'rgba(0,0,0,0.3)', padding: '4px', borderRadius: '8px', alignItems: 'center' }}>
          {/* Simulation Mode button */}
          <div className="flex-row" style={{ alignItems: 'center', gap: '2px' }}>
            <button 
              onClick={() => setAppMode('simulation')} 
              style={{ 
                padding: '0.25rem 0.75rem', 
                borderRadius: '4px', 
                border: 'none', 
                background: appMode === 'simulation' ? '#FBBF24' : 'transparent', 
                color: appMode === 'simulation' ? '#000' : '#fff', 
                cursor: 'pointer', 
                fontWeight: 'bold',
                fontSize: '0.85rem'
              }}
            >
              {t.simulation}
            </button>
            {appMode === 'simulation' && (
              <button 
                onClick={() => setShowSimSettingsModal(true)} 
                title={lang === 'he' ? 'הגדרות סימולציה' : 'Simulation Settings'}
                style={{ 
                  background: 'transparent', 
                  border: 'none', 
                  color: '#FBBF24', 
                  padding: '2px 4px', 
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                <Settings size={14} />
              </button>
            )}
          </div>

          {/* Live Mode button */}
          <button 
            onClick={() => setAppMode('live')} 
            style={{ 
              padding: '0.25rem 0.75rem', 
              borderRadius: '4px', 
              border: 'none', 
              background: appMode === 'live' ? '#EF4444' : 'transparent', 
              color: appMode === 'live' ? '#000' : '#fff', 
              cursor: 'pointer', 
              fontWeight: 'bold',
              fontSize: '0.85rem',
              display: 'flex', 
              alignItems: 'center', 
              gap: '6px' 
            }}
          >
            {t.live}
            {appMode === 'live' && (wsStatus === 'connected' ? <Wifi size={14} /> : <WifiOff size={14} />)}
          </button>

          {/* Playback Mode button */}
          <button 
            onClick={() => setAppMode('playback')} 
            style={{ 
              padding: '0.25rem 0.75rem', 
              borderRadius: '4px', 
              border: 'none', 
              background: appMode === 'playback' ? 'var(--accent-cyan)' : 'transparent', 
              color: appMode === 'playback' ? '#000' : '#fff', 
              cursor: 'pointer', 
              fontWeight: 'bold',
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}
          >
            <Play size={12} />
            {lang === 'he' ? 'ניגון' : 'Playback'}
          </button>
        </div>

        {appMode === 'live' && (
          <>
            <div style={{ width: '1px', height: '24px', background: 'rgba(255,255,255,0.2)', margin: '0 1rem' }} />
            <button 
              onClick={isRecording ? stopRecording : startRecording} 
              style={{
                background: isRecording ? 'rgba(239, 68, 68, 0.2)' : 'rgba(255,255,255,0.08)',
                border: isRecording ? '1px solid #EF4444' : '1px solid rgba(255,255,255,0.2)',
                color: isRecording ? '#EF4444' : '#fff',
                padding: '0.25rem 0.75rem',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '0.85rem',
                fontWeight: 'bold',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}
            >
              <Circle size={12} fill={isRecording ? '#EF4444' : 'none'} className={isRecording ? 'pulse-red' : ''} />
              {isRecording ? (lang === 'he' ? 'עצור הקלטה' : 'Stop Rec') : (lang === 'he' ? 'הקלט' : 'Record')}
            </button>
          </>
        )}

        {/* ADMIN MODAL TOGGLE */}
        <button
          onClick={() => setShowAdminModal(true)}
          title={lang === 'he' ? 'ניהול מערכת איומים' : 'Threat Assessment Admin'}
          style={{
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.2)',
            color: 'var(--accent-cyan)',
            padding: '0.25rem 0.6rem',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '0.8rem',
            fontWeight: 'bold',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            marginRight: lang === 'he' ? '0' : '0.5rem',
            marginLeft: lang === 'he' ? '0.5rem' : '0'
          }}
        >
          <Sliders size={14} />
          {lang === 'he' ? 'מנהל' : 'Admin'}
        </button>

        {/* LANGUAGE TOGGLE */}
        <button
          onClick={() => setLang(l => l === 'he' ? 'en' : 'he')}
          title={lang === 'he' ? 'Switch to English' : 'עבור לעברית'}
          style={{
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.2)',
            color: '#fff',
            padding: '0.25rem 0.6rem',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '0.8rem',
            fontWeight: 'bold',
            letterSpacing: '0.5px'
          }}
        >
          {lang === 'he' ? 'EN' : 'עב'}
        </button>
      </div>

      {/* Side Panels */}
      <div className="side-panels" style={{ position: 'absolute', top: '80px', left: '1rem', right: '1rem', display: 'flex', justifyContent: 'space-between', zIndex: 1000, pointerEvents: 'none' }}>
        
        {/* Left Panel */}
        <div className="left-panel glass-panel" style={{ pointerEvents: 'auto', width: '300px' }}>
          {appMode === 'playback' && (
            // Playback File Selector Dropdown at the top of the Left Panel
            <div className="flex-col" style={{ gap: '0.4rem', borderBottom: '1px solid rgba(255,255,255,0.15)', paddingBottom: '1rem', marginBottom: '0.75rem' }}>
              <span className="text-muted" style={{ fontSize: '0.85rem' }}>
                {lang === 'he' ? 'בחירת קובץ הקלטה:' : 'Select Recording File:'}
              </span>
              <div className="flex-row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                <select
                  className="config-input"
                  style={{ flex: 1, padding: '0.3rem', fontSize: '0.85rem', background: 'rgba(0,0,0,0.5)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px' }}
                  value={selectedPlaybackFile}
                  onChange={(e) => setSelectedPlaybackFile(e.target.value)}
                >
                  <option value="">{lang === 'he' ? '-- בחר הקלטה --' : '-- Select Recording --'}</option>
                  {playbackFilesList.map(f => (
                    <option key={f.filename} value={f.filename}>
                      {f.filename} ({ (f.size / (1024*1024)).toFixed(2) } MB)
                    </option>
                  ))}
                </select>
                <button 
                  onClick={fetchRecordingsList}
                  style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px', padding: '0.25rem 0.5rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  title={lang === 'he' ? 'רענן' : 'Refresh'}
                >
                  🔄
                </button>
                {selectedPlaybackFile && (
                  <button
                    onClick={() => deleteRecordingFile(selectedPlaybackFile)}
                    style={{ background: 'rgba(239, 68, 68, 0.15)', border: '1px solid var(--accent-red)', borderRadius: '4px', padding: '0.25rem 0.5rem', cursor: 'pointer', color: 'var(--accent-red)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    title={lang === 'he' ? 'מחק הקלטה זו' : 'Delete this recording'}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Standard Radar Settings Panel */}
          <div className="flex-row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{t.radarLabel} {selectedRadarId}</h2>
            <Settings size={20} className="text-muted" cursor="pointer" onClick={() => setShowConfigModal(true)} />
          </div>

          <div className="flex-col">
            <span className="text-muted">{t.status}</span>
            <button className={`glowing-btn ${selectedRadar.isActive ? 'active' : ''}`} onClick={() => handleTogglePower(selectedRadarId)}>
              <Power size={18} style={{ marginRight: '8px', verticalAlign: 'middle' }} />
              {selectedRadar.isActive ? t.transmitting : t.standby}
            </button>
          </div>

          <div className="flex-col">
            <span className="text-muted">{t.homeLocation}</span>
            <div className="flex-row" style={{ justifyContent: 'space-between' }}>
              <span style={{ fontSize: '0.85rem' }}>{selectedRadar.homeLocation[0].toFixed(5)}, {selectedRadar.homeLocation[1].toFixed(5)}</span>
              <MapPin 
                size={16} 
                style={{ color: 'var(--accent-cyan)', cursor: 'pointer' }} 
                onClick={() => {
                  if (mapRef.current) {
                    mapRef.current.flyTo({ 
                      center: [selectedRadar.homeLocation[1], selectedRadar.homeLocation[0]], 
                      zoom: 14, 
                      duration: 1500 
                    });
                  }
                }}
              />
            </div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t.altLabel}: {selectedRadar.homeLocation[2]}m</span>
          </div>

          <div className="flex-col">
            <div className="flex-row" style={{ justifyContent: 'space-between' }}>
              <span className="text-muted">{t.fadeLabel}</span>
              <span style={{ color: 'var(--accent-cyan)', fontSize: '0.9rem' }}>{selectedRadar.fadeThreshold}s</span>
            </div>
            <input type="range" min="1" max="30" value={selectedRadar.fadeThreshold} onChange={(e) => updateRadarConfig('fadeThreshold', parseInt(e.target.value))} />
          </div>

          <div className="flex-col">
            <div className="flex-row" style={{ justifyContent: 'space-between' }}>
              <span className="text-muted">{t.trailLengthLabel}</span>
              <span style={{ color: 'var(--accent-amber)', fontSize: '0.9rem' }}>{filters.trailLengthSeconds}s</span>
            </div>
            <input type="range" min="1" max="60" value={filters.trailLengthSeconds} onChange={(e) => setFilters({...filters, trailLengthSeconds: parseInt(e.target.value)})} style={{ accentColor: 'var(--accent-amber)' }} />
          </div>

          <div className="flex-col">
            <div className="flex-row" style={{ justifyContent: 'space-between' }}>
              <span className="text-muted">{t.thresholdLabel}</span>
              <span style={{ color: 'var(--accent-red)', fontSize: '0.9rem', fontWeight: 'bold' }}>{(uavThreshold * 100).toFixed(0)}%</span>
            </div>
            <input 
              type="range" 
              min="0" 
              max="100" 
              value={uavThreshold * 100} 
              onChange={(e) => setUavThreshold(parseFloat(e.target.value) / 100)} 
              style={{ accentColor: 'var(--accent-red)' }}
            />
          </div>

          <div className="flex-col" style={{ marginTop: '0.5rem' }}>
            <span className="text-muted" style={{ marginBottom: '0.5rem' }}>{t.mapType}</span>
            <div className="flex-row" style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '4px', padding: '4px' }}>
              <button onClick={() => setMapType('dark')} style={{ flex: 1, padding: '0.25rem', border: 'none', background: mapType === 'dark' ? 'var(--accent-cyan)' : 'transparent', color: mapType === 'dark' ? '#000' : '#fff', cursor: 'pointer', borderRadius: '2px' }}>{t.dark}</button>
              <button onClick={() => setMapType('satellite')} style={{ flex: 1, padding: '0.25rem', border: 'none', background: mapType === 'satellite' ? 'var(--accent-cyan)' : 'transparent', color: mapType === 'satellite' ? '#000' : '#fff', cursor: 'pointer', borderRadius: '2px' }}>{t.satellite}</button>
            </div>
          </div>

          <div className="flex-col" style={{ gap: '0.5rem', marginTop: '1rem' }}>
            <div className="flex-row" style={{ gap: '0.5rem' }}>
              <button onClick={() => setShowFilterModal(true)} style={{ flex: 1, background: 'rgba(0, 229, 255, 0.1)', border: '1px solid var(--accent-cyan)', padding: '0.5rem', color: 'var(--accent-cyan)', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                <Filter size={16} /> {t.filters}
              </button>
              <button onClick={() => setShowZonesModal(true)} style={{ flex: 1, background: 'rgba(239, 68, 68, 0.1)', border: '1px solid var(--accent-red)', padding: '0.5rem', color: 'var(--accent-red)', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                <ShieldAlert size={16} /> {t.zones}
              </button>
            </div>
            <button onClick={() => { setIsDrawingZone(true); setShowZonesModal(false); }} style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px dashed #EF4444', padding: '0.5rem', color: '#EF4444', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
              {t.drawZone}
            </button>
          </div>
        </div>

        {/* Right Panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '320px', pointerEvents: 'none' }}>
          {(() => {
            // Unified list: detections and/or tracks based on displayMode
            const listItems: Array<{ id: string; speed: number; classification: 'drone'|'unknown'|'bird'; probUAV?: number; lat: number; lng: number; alt: number; heading: number; lastUpdated: number; radarId?: number; radarIds?: number[]; raw?: any; _isTrack?: boolean }> = [
              ...(displayMode !== 'tracks' ? filteredDetections.map(d => ({ ...d, _isTrack: false })) : []),
              ...(displayMode !== 'detections' ? filteredTracks.map(tr => ({ ...tr, radarId: tr.radarIds?.[0] ?? 0, _isTrack: true })) : [])
            ];
            const visibleCount = listItems.length;
            if (visibleCount === 0) return null;

            const sorted = [...listItems].sort((a, b) => {
              if (defenseZones.length > 0) {
                const scoreA = computeThreatScore(a as any, defenseZones, threatWeights).score;
                const scoreB = computeThreatScore(b as any, defenseZones, threatWeights).score;
                return scoreB - scoreA;
              }
              return 0;
            });

            const listTitle = displayMode === 'detections' ? `${t.activeDetections} (${visibleCount})`
              : displayMode === 'tracks' ? `${t.activeTracks} (${visibleCount})`
              : `${t.activeItems} (${visibleCount})`;

            return (
              <div className="glass-panel" style={{ pointerEvents: 'auto', maxHeight: '40vh', overflowY: 'auto' }}>
                <h3 style={{ margin: '0 0 1rem 0', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1.1rem' }}>
                  <List size={18} /> {listTitle}
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {sorted.map(item => {
                    const isSelected = currentSelectedDetection?.id === item.id;
                    const classification = getClassification(item as any);
                    let color = 'var(--accent-orange)';
                    let threatScorePct = 0;
                    if (defenseZones.length > 0) {
                      const { score } = computeThreatScore(item as any, defenseZones, threatWeights);
                      color = getThreatColor(score);
                      threatScorePct = Math.round(score * 100);
                    } else {
                      if (classification === 'drone') color = item._isTrack ? '#FF6B6B' : 'var(--accent-red)';
                      else if (classification === 'bird') color = item._isTrack ? '#34D399' : '#10B981';
                      else color = item._isTrack ? 'var(--accent-cyan)' : 'var(--accent-orange)';
                    }

                    return (
                      <div key={item.id}
                        onClick={() => setSelectedDetection(item as any)}
                        style={{
                          padding: '0.5rem',
                          background: isSelected ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.3)',
                          border: `1px solid ${isSelected ? color : 'rgba(255,255,255,0.1)'}`,
                          borderRadius: '4px', cursor: 'pointer',
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: color, flexShrink: 0 }} />
                          {item._isTrack && (
                            <span style={{
                              fontSize: '0.65rem', fontWeight: '900', padding: '1px 4px',
                              borderRadius: '3px', background: color, color: '#000',
                              flexShrink: 0, letterSpacing: '0.3px'
                            }}>TRK</span>
                          )}
                          <span style={{ fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.85rem' }}>{item.id}</span>
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', flexShrink: 0 }}>
                            ({classification === 'drone' ? t.uav : (classification === 'bird' ? t.bird : t.unknown)})
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                          {item._isTrack && (item as any).radarIds?.length > 1 && (
                            <span style={{ fontSize: '0.7rem', color: color, background: 'rgba(0,229,255,0.1)', padding: '1px 5px', borderRadius: '3px', fontWeight: 'bold' }}>
                              {(item as any).radarIds.length} {t.radarsLabel}
                            </span>
                          )}
                          {defenseZones.length > 0 && (
                            <span style={{ fontSize: '0.8rem', fontWeight: 'bold', color, background: 'rgba(0,0,0,0.4)', padding: '2px 6px', borderRadius: '4px' }}>
                              {threatScorePct}%
                            </span>
                          )}
                          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{item.speed.toFixed(0)}m/s</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {currentSelectedDetection && (() => {
            const classification = getClassification(currentSelectedDetection);
            let threatDetails = null;
            let targetColor = 'var(--accent-orange)';
            if (classification === 'drone') targetColor = 'var(--accent-red)';
            else if (classification === 'bird') targetColor = '#10B981';

            if (defenseZones.length > 0) {
              const threat = computeThreatScore(currentSelectedDetection, defenseZones, threatWeights);
              targetColor = getThreatColor(threat.score);
              threatDetails = threat;
            }

            return (
              <div className="glass-panel" style={{ pointerEvents: 'auto' }}>
                <div className="flex-row" style={{ justifyContent: 'space-between' }}>
                  <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Crosshair size={20} color={targetColor} /> {t.target} {currentSelectedDetection.id}
                  </h3>
                  <button onClick={() => setSelectedDetection(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1.2rem' }}>&times;</button>
                </div>

                <div className="flex-row" style={{ gap: '0.5rem', marginTop: '1rem', paddingBottom: '1rem', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <button onClick={handleCenterSelected} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', padding: '0.4rem', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem' }}><Focus size={14} /> {t.center}</button>
                  <button onClick={handleDeleteSelected} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', background: 'rgba(239, 68, 68, 0.2)', border: '1px solid var(--accent-red)', color: 'var(--accent-red)', padding: '0.4rem', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem' }}><Trash2 size={14} /> {t.drop}</button>
                </div>

                {/* Threat Score Card Section */}
                {threatDetails && (
                  <div style={{ marginTop: '1rem', padding: '0.75rem', background: 'rgba(0,0,0,0.3)', borderRadius: '6px', border: `1px solid ${targetColor}` }}>
                    <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: 'bold' }}>{t.threatScore}</span>
                      <span style={{ fontSize: '1rem', fontWeight: '900', color: targetColor }}>
                        {Math.round(threatDetails.score * 100)}%
                      </span>
                    </div>
                    {/* Visual threat meter */}
                    <div style={{ width: '100%', height: '8px', background: 'rgba(255,255,255,0.1)', borderRadius: '4px', overflow: 'hidden', marginBottom: '8px' }}>
                      <div style={{ width: `${Math.round(threatDetails.score * 100)}%`, height: '100%', background: targetColor, borderRadius: '4px', transition: 'width 0.3s' }} />
                    </div>
                    <div className="flex-col" style={{ gap: '4px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      <div className="flex-row" style={{ justifyContent: 'space-between' }}>
                        <span>{t.classLabel}:</span>
                        <span style={{ color: '#fff' }}>{(threatDetails.sClass * 100).toFixed(0)}%</span>
                      </div>
                      <div className="flex-row" style={{ justifyContent: 'space-between' }}>
                        <span>{t.proximity}:</span>
                        <span style={{ color: '#fff' }}>
                          {threatDetails.distM < 0 ? (lang === 'he' ? 'בתוך המרחב' : 'Inside Zone') : `${threatDetails.distM.toFixed(0)}m`}
                        </span>
                      </div>
                      <div className="flex-row" style={{ justifyContent: 'space-between' }}>
                        <span>{t.eta}:</span>
                        <span style={{ color: '#fff' }}>
                          {threatDetails.etaSec === -1 || threatDetails.etaSec === Infinity ? '∞' : `${threatDetails.etaSec.toFixed(0)}s`}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex-row" style={{ justifyContent: 'space-between', marginTop: '1rem' }}>
                  <span className="text-muted">{t.classLabel}</span>
                  <span style={{ color: '#fff', backgroundColor: classification === 'drone' ? 'var(--accent-red)' : (classification === 'bird' ? '#10B981' : 'var(--accent-orange)'), padding: '0.25rem 0.5rem', borderRadius: '4px', fontWeight: 'bold', fontSize: '0.85rem' }}>
                    {classification === 'drone' ? t.uav : (classification === 'bird' ? t.bird : t.unknown)}
                  </span>
                </div>

                {currentSelectedDetection.probUAV !== undefined && (
                  <div className="flex-row" style={{ justifyContent: 'space-between', marginTop: '0.5rem' }}>
                    <span className="text-muted">{t.probUavLabel}</span>
                    <span style={{ fontWeight: 'bold', color: 'var(--accent-cyan)' }}>
                      {(currentSelectedDetection.probUAV * 100).toFixed(1)}%
                    </span>
                  </div>
                )}

                {currentSelectedDetection.raw && currentSelectedDetection.raw.rcs !== undefined && (
                  <div className="flex-row" style={{ justifyContent: 'space-between', marginTop: '0.5rem' }}>
                    <span className="text-muted">RCS</span>
                    <span style={{ fontWeight: 'bold', color: 'var(--accent-cyan)' }}>
                      {currentSelectedDetection.raw.rcs.toFixed(1)} dBsqm
                    </span>
                  </div>
                )}

                <div className="flex-row" style={{ justifyContent: 'space-between', marginTop: '0.5rem' }}>
                  <span className="text-muted">{t.altitudeLabel}</span>
                  <span>
                    {currentSelectedDetection.alt.toFixed(1)}m /
                    <span style={{ color: 'var(--accent-cyan)', marginLeft: '4px' }}>
                      {getTerrainAgl(currentSelectedDetection.lng, currentSelectedDetection.lat, currentSelectedDetection.alt)}m {t.aglMarker}
                    </span>
                  </span>
                </div>
              </div>
            );
          })()}

        </div>
      </div>

      {/* FILTER Modal */}
      {showFilterModal && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-panel" style={{ width: '450px', padding: '2rem', pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div className="flex-row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}><Filter size={24} /> {t.filterTitle}</h2>
              <button onClick={() => setShowFilterModal(false)} style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '1.5rem' }}>&times;</button>
            </div>
            
            {/* Target Type Filters */}
            <div className="flex-col" style={{ gap: '0.75rem' }}>
              <span className="text-muted">{t.typeFilter}</span>
              <div className="flex-row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
                <button 
                  onClick={() => setFilters({ ...filters, showDrone: !filters.showDrone })}
                  style={{ flex: 1, padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--accent-red)', background: filters.showDrone ? 'rgba(239, 68, 68, 0.2)' : 'transparent', color: filters.showDrone ? '#fff' : 'var(--text-secondary)', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  {t.uav}
                </button>
                <button 
                  onClick={() => setFilters({ ...filters, showUnknown: !filters.showUnknown })}
                  style={{ flex: 1, padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--accent-orange)', background: filters.showUnknown ? 'rgba(249, 115, 22, 0.2)' : 'transparent', color: filters.showUnknown ? '#fff' : 'var(--text-secondary)', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  {t.unknown}
                </button>
                <button 
                  onClick={() => setFilters({ ...filters, showBird: !filters.showBird })}
                  style={{ flex: 1, padding: '0.5rem', borderRadius: '6px', border: '1px solid #10B981', background: filters.showBird ? 'rgba(16, 185, 129, 0.2)' : 'transparent', color: filters.showBird ? '#fff' : 'var(--text-secondary)', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  {t.bird}
                </button>
              </div>
            </div>

            {/* Speed Limits */}
            <div className="flex-col" style={{ gap: '0.5rem' }}>
              <span className="text-muted">{t.speedRange}</span>
              <div className="flex-row" style={{ gap: '1rem' }}>
                <div className="flex-col" style={{ flex: 1 }}>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t.minLabel}</label>
                  <input type="number" className="config-input" value={filters.minSpeed} onChange={(e) => setFilters({...filters, minSpeed: parseFloat(e.target.value) || 0})} placeholder="0" />
                </div>
                <div className="flex-col" style={{ flex: 1 }}>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t.maxLabel}</label>
                  <input type="number" className="config-input" value={filters.maxSpeed} onChange={(e) => setFilters({...filters, maxSpeed: parseFloat(e.target.value) || 0})} placeholder="100" />
                </div>
              </div>
            </div>

            {/* AGL Height Limits */}
            <div className="flex-col" style={{ gap: '0.5rem' }}>
              <span className="text-muted">{t.aglRange}</span>
              <div className="flex-row" style={{ gap: '1rem' }}>
                <div className="flex-col" style={{ flex: 1 }}>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t.minLabel}</label>
                  <input type="number" className="config-input" value={filters.minAgl} onChange={(e) => setFilters({...filters, minAgl: parseFloat(e.target.value) || 0})} placeholder="-50" />
                </div>
                <div className="flex-col" style={{ flex: 1 }}>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t.maxLabel}</label>
                  <input type="number" className="config-input" value={filters.maxAgl} onChange={(e) => setFilters({...filters, maxAgl: parseFloat(e.target.value) || 0})} placeholder="1000" />
                </div>
              </div>
            </div>

            {/* RCS Limits */}
            <div className="flex-col" style={{ gap: '0.5rem' }}>
              <span className="text-muted">{lang === 'he' ? 'טווח RCS (dBsqm)' : 'RCS Range (dBsqm)'}</span>
              <div className="flex-row" style={{ gap: '1rem' }}>
                <div className="flex-col" style={{ flex: 1 }}>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t.minLabel}</label>
                  <input type="number" className="config-input" value={filters.minRcs} onChange={(e) => {
                    const val = e.target.value;
                    setFilters({...filters, minRcs: val === '' || val === '-' ? val as any : parseFloat(val)});
                  }} placeholder="-50" />
                </div>
                <div className="flex-col" style={{ flex: 1 }}>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t.maxLabel}</label>
                  <input type="number" className="config-input" value={filters.maxRcs} onChange={(e) => {
                    const val = e.target.value;
                    setFilters({...filters, maxRcs: val === '' || val === '-' ? val as any : parseFloat(val)});
                  }} placeholder="30" />
                </div>
              </div>
            </div>

            <button className="glowing-btn active" onClick={() => setShowFilterModal(false)}>{t.apply}</button>
          </div>
        </div>
      )}

      {/* ZONES Modal */}
      {showZonesModal && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-panel" style={{ width: '400px', padding: '2rem', pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div className="flex-row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}><ShieldAlert size={24} color="var(--accent-red)" /> {t.zonesTitle}</h2>
              <button onClick={() => setShowZonesModal(false)} style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '1.5rem' }}>&times;</button>
            </div>
            <div className="flex-col" style={{ gap: '1rem', maxHeight: '40vh', overflowY: 'auto' }}>
              {ignoreZones.map((zone, idx) => (
                <div key={zone.id} style={{ background: 'rgba(0,0,0,0.3)', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
                  <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div className="flex-col" style={{ gap: '2px' }}>
                      <span style={{ fontWeight: 'bold', color: '#fff', fontSize: '0.95rem' }}>
                        {zone.name || `${t.zoneItem} ${idx + 1}`}
                      </span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        {t.aglSuffix}: {zone.minAgl}–{zone.maxAgl}m
                      </span>
                    </div>
                    <button onClick={() => setIgnoreZones(ignoreZones.filter(z => z.id !== zone.id))} style={{ background: 'transparent', border: 'none', color: 'var(--accent-red)', cursor: 'pointer', paddingTop: '2px' }}><Trash2 size={16} /></button>
                  </div>
                </div>
              ))}
            </div>
            <button onClick={() => { setIsDrawingZone(true); setShowZonesModal(false); }} style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px dashed var(--accent-red)', padding: '0.75rem', color: '#fff', borderRadius: '8px', cursor: 'pointer' }}>
              {t.drawPolygon}
            </button>
            <button className="glowing-btn active" onClick={() => setShowZonesModal(false)}>{t.close}</button>
          </div>
        </div>
      )}

      {/* Debug Modal */}
      {isDebugMode && currentSelectedDetection && currentSelectedDetection.raw && (
        <div style={{
          position: 'absolute',
          top: `${debugPos.y}px`,
          left: `${debugPos.x}px`,
          width: '350px',
          background: 'rgba(0,0,0,0.85)',
          zIndex: 9998,
          borderRadius: '8px',
          border: '1px solid var(--accent-cyan)',
          padding: '1rem',
          pointerEvents: 'auto'
        }}>
          <div
            className="flex-row"
            onMouseDown={(e) => {
              if ((e.target as HTMLElement).tagName !== 'BUTTON') {
                setIsDraggingDebug(true);
                setDragStartDebug({
                  x: e.clientX - debugPos.x,
                  y: e.clientY - debugPos.y
                });
              }
            }}
            style={{
              justifyContent: 'space-between',
              borderBottom: '1px solid rgba(0, 229, 255, 0.3)',
              paddingBottom: '0.5rem',
              marginBottom: '0.5rem',
              cursor: 'move',
              userSelect: 'none',
              alignItems: 'center'
            }}
          >
            <h3 style={{ margin: 0, color: 'var(--accent-cyan)', fontSize: '1rem' }}>Debug: {currentSelectedDetection.id}</h3>
            <button
              onClick={() => setIsDebugMode(false)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--accent-cyan)',
                cursor: 'pointer',
                fontSize: '1.2rem',
                padding: '0 4px',
                lineHeight: 1
              }}
            >
              &times;
            </button>
          </div>
          <div style={{ maxHeight: '300px', overflowY: 'auto', textAlign: 'left', direction: 'ltr' }}>
            <pre style={{ margin: 0, color: '#0f0', fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(currentSelectedDetection.raw, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {showConfigModal && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-panel" style={{ width: '650px', maxHeight: '90vh', overflowY: 'auto', padding: '2rem', pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: '1.5rem', textAlign: lang === 'he' ? 'right' : 'left', direction: lang === 'he' ? 'rtl' : 'ltr' }}>
            <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0 }}>{selectedRadar.name || `${t.radarLabel} ${selectedRadarId}`} — {t.configTitle}</h2>
              <button onClick={() => { setShowConfigModal(false); setHelpField(null); }} style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '1.5rem', marginLeft: lang === 'he' ? '0' : 'auto', marginRight: lang === 'he' ? 'auto' : '0' }}>&times;</button>
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              
              {/* SECTION 1: RADAR SETTINGS */}
              <div style={{ gridColumn: 'span 2', borderBottom: '1px solid rgba(255,255,255,0.15)', paddingBottom: '0.4rem', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Radar size={18} color="var(--accent-cyan)" />
                <h4 style={{ margin: 0, color: 'var(--accent-cyan)', fontWeight: 'bold' }}>
                  {lang === 'he' ? 'הגדרות מכ"ם בסיסיות' : 'Basic Radar Settings'}
                </h4>
              </div>
              
              <div className="flex-col">
                <label className="text-muted">
                  {lang === 'he' ? 'שם תצוגה' : 'Display Name'}
                  {renderHelpButton('name')}
                </label>
                <input type="text" className="config-input" value={selectedRadar.name || ''} onChange={(e) => updateRadarConfig('name', e.target.value)} placeholder={`Radar ${selectedRadar.id}`} />
              </div>
              {renderHelpText('name')}

              <div className="flex-col">
                <label className="text-muted">
                  {t.radarIp}
                  {renderHelpButton('ip')}
                </label>
                <input type="text" className="config-input" value={selectedRadar.ip} onChange={(e) => updateRadarConfig('ip', e.target.value)} />
              </div>
              {renderHelpText('ip')}

              <div className="flex-col">
                <label className="text-muted">
                  {lang === 'he' ? 'ערוץ תדר (Frequency Channel)' : 'Frequency Channel'}
                  {renderHelpButton('freqChannel')}
                </label>
                <input type="number" min="1" max="4" className="config-input" value={selectedRadar.freqChannel || 1} onChange={(e) => updateRadarConfig('freqChannel', e.target.value)} />
              </div>
              {renderHelpText('freqChannel')}

              {/* SECTION 2: LOCATION & ORIENTATION */}
              <div style={{ gridColumn: 'span 2', borderBottom: '1px solid rgba(255,255,255,0.15)', paddingBottom: '0.4rem', marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <MapPin size={18} color="var(--accent-cyan)" />
                <h4 style={{ margin: 0, color: 'var(--accent-cyan)', fontWeight: 'bold' }}>
                  {lang === 'he' ? 'מיקום ואוריאנטציה' : 'Location & Orientation'}
                </h4>
              </div>

              <div className="flex-col" style={{ gridColumn: 'span 2' }}>
                <label className="text-muted">
                  {t.radarLocation}
                  {renderHelpButton('homeLocation')}
                </label>
                <div className="flex-row" style={{ gap: '0.5rem', direction: 'ltr', alignItems: 'center' }}>
                  <input type="number" className="config-input" style={{ flex: 1 }} value={selectedRadar.homeLocation[0]} onChange={(e) => updateRadarConfig('homeLocation', [parseFloat(e.target.value), selectedRadar.homeLocation[1], selectedRadar.homeLocation[2]])} placeholder="Latitude" />
                  <input type="number" className="config-input" style={{ flex: 1 }} value={selectedRadar.homeLocation[1]} onChange={(e) => updateRadarConfig('homeLocation', [selectedRadar.homeLocation[0], parseFloat(e.target.value), selectedRadar.homeLocation[2]])} placeholder="Longitude" />
                  <input type="number" className="config-input" style={{ flex: 1 }} value={selectedRadar.homeLocation[2]} onChange={(e) => updateRadarConfig('homeLocation', [selectedRadar.homeLocation[0], selectedRadar.homeLocation[1], parseFloat(e.target.value)])} placeholder="Altitude ASL (m)" />
                  <button
                    type="button"
                    onClick={() => {
                      setIsSelectingLocationFromMap(true);
                      setShowConfigModal(false);
                    }}
                    style={{
                      background: 'var(--accent-cyan)',
                      color: 'var(--bg-color)',
                      border: 'none',
                      borderRadius: '4px',
                      padding: '0.5rem 1rem',
                      cursor: 'pointer',
                      fontWeight: 'bold',
                      fontSize: '0.85rem',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {lang === 'he' ? 'בחר מהמפה' : 'Select from Map'}
                  </button>
                </div>
              </div>
              {renderHelpText('homeLocation')}

              <div className="flex-col">
                <label className="text-muted">
                  {t.radarHeading}
                  {renderHelpButton('heading')}
                </label>
                <input type="number" className="config-input" value={selectedRadar.heading} onChange={(e) => updateRadarConfig('heading', e.target.value)} />
              </div>
              {renderHelpText('heading')}

              <div className="flex-col">
                <label className="text-muted">
                  {t.radarElevation}
                  {renderHelpButton('pitch')}
                </label>
                <input type="number" step="0.1" className="config-input" value={selectedRadar.pitch ?? 0} onChange={(e) => updateRadarConfig('pitch', e.target.value)} />
              </div>
              {renderHelpText('pitch')}

              <div className="flex-col">
                <label className="text-muted">
                  {t.radarRoll}
                  {renderHelpButton('roll')}
                </label>
                <input type="number" step="0.1" className="config-input" value={selectedRadar.roll ?? 0} onChange={(e) => updateRadarConfig('roll', e.target.value)} />
              </div>
              {renderHelpText('roll')}

              <div className="flex-col" style={{ gridColumn: 'span 2', background: 'rgba(255,255,255,0.05)', padding: '0.75rem', borderRadius: '6px', marginTop: '0.5rem' }}>
                <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <div className="flex-row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                    <input type="checkbox" id="useImuCheckbox" checked={!!selectedRadar.useImu} onChange={(e) => updateRadarConfig('useImu', e.target.checked)} />
                    <label htmlFor="useImuCheckbox" style={{ cursor: 'pointer', fontWeight: 'bold' }}>
                      {lang === 'he' ? 'קבלת זוויות IMU מהמכ"ם' : 'Get IMU Angles from Radar'}
                    </label>
                    {renderHelpButton('useImu')}
                  </div>
                  {liveImuData[selectedRadarId] && (
                    <span style={{ fontSize: '0.8rem', color: 'var(--accent-cyan)' }}>
                      Live IMU: P: {liveImuData[selectedRadarId].pitch.toFixed(1)}°, R: {liveImuData[selectedRadarId].roll.toFixed(1)}°
                    </span>
                  )}
                </div>
              </div>
              {renderHelpText('useImu')}

              {/* SECTION 3: DETECTION FILTERS */}
              <div style={{ gridColumn: 'span 2', borderBottom: '1px solid rgba(255,255,255,0.15)', paddingBottom: '0.4rem', marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Filter size={18} color="var(--accent-cyan)" />
                <h4 style={{ margin: 0, color: 'var(--accent-cyan)', fontWeight: 'bold' }}>
                  {lang === 'he' ? 'מסנני גילוי (פילטרים במכ"ם)' : 'Detection Filters (Radar Layer)'}
                </h4>
              </div>

              <div className="flex-col">
                <label className="text-muted">
                  {t.azFov}
                  {renderHelpButton('azFov')}
                </label>
                <div className="flex-row" style={{ gap: '0.5rem', direction: 'ltr' }}>
                  <input type="number" className="config-input" style={{ flex: 1 }} value={selectedRadar.azFovMin} onChange={(e) => updateRadarConfig('azFovMin', e.target.value)} placeholder="Min" />
                  <input type="number" className="config-input" style={{ flex: 1 }} value={selectedRadar.azFovMax} onChange={(e) => updateRadarConfig('azFovMax', e.target.value)} placeholder="Max" />
                </div>
              </div>
              {renderHelpText('azFov')}

              <div className="flex-col">
                <label className="text-muted">
                  {lang === 'he' ? 'גזרת הגבהה Min/Max' : 'Elevation FOV Min/Max'}
                  {renderHelpButton('elFov')}
                </label>
                <div className="flex-row" style={{ gap: '0.5rem', direction: 'ltr' }}>
                  <input type="number" className="config-input" style={{ flex: 1 }} value={selectedRadar.elFovMin} onChange={(e) => updateRadarConfig('elFovMin', e.target.value)} placeholder="Min" />
                  <input type="number" className="config-input" style={{ flex: 1 }} value={selectedRadar.elFovMax} onChange={(e) => updateRadarConfig('elFovMax', e.target.value)} placeholder="Max" />
                </div>
              </div>
              {renderHelpText('elFov')}

              <div className="flex-col">
                <label className="text-muted">
                  {lang === 'he' ? 'סינון RCS Min/Max (dBsm)' : 'RCS Filter Min/Max (dBsm)'}
                  {renderHelpButton('rcs')}
                </label>
                <div className="flex-row" style={{ gap: '0.5rem', direction: 'ltr' }}>
                  <input type="number" className="config-input" style={{ flex: 1 }} value={selectedRadar.minRcs} onChange={(e) => updateRadarConfig('minRcs', e.target.value)} placeholder="Min" />
                  <input type="number" className="config-input" style={{ flex: 1 }} value={selectedRadar.maxRcs} onChange={(e) => updateRadarConfig('maxRcs', e.target.value)} placeholder="Max" />
                </div>
              </div>
              {renderHelpText('rcs')}

              <div className="flex-col">
                <label className="text-muted">
                  {lang === 'he' ? 'טווח גילוי מקסימלי (מטרים)' : 'Max Operating Range (m)'}
                  {renderHelpButton('maxRange')}
                </label>
                <input type="number" className="config-input" value={selectedRadar.maxRange} onChange={(e) => updateRadarConfig('maxRange', e.target.value)} />
              </div>
              {renderHelpText('maxRange')}

              <div className="flex-col">
                <label className="text-muted">
                  {lang === 'he' ? 'רוחב מסנן החזרי קרקע (Bins)' : 'Clutter Mask Width (Bins)'}
                  {renderHelpButton('clutterWidth')}
                </label>
                <input type="number" min="1" max="5" className="config-input" value={selectedRadar.clutterWidth ?? 3} onChange={(e) => updateRadarConfig('clutterWidth', e.target.value)} />
              </div>
              {renderHelpText('clutterWidth')}

            </div>
            <button className="glowing-btn active" onClick={() => { setShowConfigModal(false); setHelpField(null); }} style={{ marginTop: '0.5rem' }}>{t.save}</button>
          </div>
        </div>
      )}

      {/* THREAT ENGINE / DEFENSE ZONE ADMIN MODAL */}
      {showAdminModal && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-panel" style={{ width: '600px', maxHeight: '90vh', overflowY: 'auto', padding: '2.5rem', pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            
            <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '1rem' }}>
              <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--accent-cyan)' }}>
                <Sliders size={26} /> {t.adminTitle}
              </h2>
              <button onClick={() => setShowAdminModal(false)} style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '1.8rem' }}>&times;</button>
            </div>

            <div className="flex-col" style={{ padding: '0 0 1rem 0', borderBottom: '1px solid rgba(255,255,255,0.1)', gap: '1rem' }}>
              <div className="flex-row" style={{ gap: '2rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#fff', cursor: 'pointer' }}>
                  <input type="checkbox" checked={isDebugMode} onChange={(e) => setIsDebugMode(e.target.checked)} style={{ width: '1.2rem', height: '1.2rem', accentColor: 'var(--accent-cyan)' }} />
                  {t.debugMode}
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#fff', cursor: 'pointer' }}>
                  <input type="checkbox" checked={filterOutsideFov} onChange={(e) => setFilterOutsideFov(e.target.checked)} style={{ width: '1.2rem', height: '1.2rem', accentColor: 'var(--accent-cyan)' }} />
                  {t.filterFov}
                </label>
              </div>
              <div className="flex-row" style={{ alignItems: 'center', gap: '10px', marginTop: '0.25rem' }}>
                <span className="text-muted" style={{ fontSize: '0.85rem' }}>
                  {lang === 'he' ? 'זמן הקלטה מקסימלי (דקות):' : 'Max Recording Duration (minutes):'}
                </span>
                <input 
                  type="number" 
                  className="config-input" 
                  style={{ width: '80px', padding: '0.2rem 0.5rem', textAlign: 'center', fontSize: '0.9rem' }} 
                  value={maxRecordingDuration} 
                  onChange={(e) => setMaxRecordingDuration(Math.max(1, parseInt(e.target.value, 10) || 10))} 
                />
              </div>
              <div className="flex-col" style={{ gap: '4px', marginTop: '0.75rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '0.75rem' }}>
                <div className="flex-row" style={{ justifyContent: 'space-between', fontSize: '0.9rem' }}>
                  <span className="text-muted">
                    {lang === 'he' ? 'סף התראת איום אווירי:' : 'Aerial Threat Alert Threshold:'}
                  </span>
                  <span style={{ color: 'var(--accent-red)', fontWeight: 'bold' }}>
                    {Math.round(alertThreshold * 100)}%
                  </span>
                </div>
                <input 
                  type="range" min="0" max="1" step="0.05"
                  value={alertThreshold} 
                  onChange={(e) => setAlertThreshold(parseFloat(e.target.value))} 
                  style={{ accentColor: 'var(--accent-red)', width: '100%' }}
                />
              </div>
              
              <div className="flex-row" style={{ gap: '1rem', marginTop: '0.75rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '0.75rem' }}>
                <div className="flex-col" style={{ flex: 1, gap: '4px' }}>
                  <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    {lang === 'he' ? 'זמן תצוגת פופ-אפ:' : 'Popup Alert Duration:'}
                  </label>
                  <select
                    className="config-input"
                    value={alertPopupDuration}
                    onChange={(e) => setAlertPopupDuration(parseInt(e.target.value, 10))}
                    style={{ background: 'rgba(0,0,0,0.5)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', padding: '0.3rem', borderRadius: '4px', fontSize: '0.85rem' }}
                  >
                    <option value="-1">{lang === 'he' ? 'עד לסגירת החלון ידנית' : 'Until closed manually'}</option>
                    <option value="0">{lang === 'he' ? 'כשהאיום נעלם מהמכ"ם' : 'When target disappears'}</option>
                    <option value="5">5 {lang === 'he' ? 'שניות' : 'Seconds'}</option>
                    <option value="10">10 {lang === 'he' ? 'שניות' : 'Seconds'}</option>
                    <option value="30">30 {lang === 'he' ? 'שניות' : 'Seconds'}</option>
                    <option value="60">60 {lang === 'he' ? 'שניות' : 'Seconds'}</option>
                  </select>
                </div>

                <div className="flex-col" style={{ flex: 1, gap: '4px' }}>
                  <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    {lang === 'he' ? 'סוג צליל התראה:' : 'Alert Sound Type:'}
                  </label>
                  <div className="flex-row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                    <select
                      className="config-input"
                      value={alertSoundType}
                      onChange={(e) => setAlertSoundType(e.target.value as any)}
                      style={{ flex: 1, background: 'rgba(0,0,0,0.5)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', padding: '0.3rem', borderRadius: '4px', fontSize: '0.85rem' }}
                    >
                      <option value="siren">{lang === 'he' ? 'סירנה עולה ויורדת' : 'Rising Siren'}</option>
                      <option value="sonar">{lang === 'he' ? 'פינג סונאר' : 'Sonar Ping'}</option>
                      <option value="beeps">{lang === 'he' ? 'צפצופים מהירים' : 'Urgent Beeps'}</option>
                      <option value="warble">{lang === 'he' ? 'פולסים מהירים (וורבל)' : 'Warble'}</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => playAlertSound()}
                      style={{
                        background: 'var(--accent-cyan)',
                        color: '#000',
                        border: 'none',
                        borderRadius: '4px',
                        padding: '0.3rem 0.6rem',
                        cursor: 'pointer',
                        fontSize: '0.8rem',
                        fontWeight: 'bold',
                        whiteSpace: 'nowrap'
                      }}
                      title={lang === 'he' ? 'בדיקת צליל' : 'Test sound'}
                    >
                      🔊 {lang === 'he' ? 'בדיקה' : 'Test'}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Weights Sliders */}
            <div className="flex-col" style={{ gap: '1.25rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Activity size={18} color="var(--accent-cyan)" /> {t.weightsTitle}
              </h3>
              
              {/* Classification Weight */}
              <div className="flex-col" style={{ gap: '4px' }}>
                <div className="flex-row" style={{ justifyContent: 'space-between', fontSize: '0.9rem' }}>
                  <span className="text-muted">{t.wClassLabel}</span>
                  <span style={{ color: 'var(--accent-cyan)', fontWeight: 'bold' }}>{threatWeights.wClass.toFixed(2)}</span>
                </div>
                <input
                  type="range" min="0" max="1" step="0.05"
                  value={threatWeights.wClass}
                  onChange={(e) => setThreatWeights({ ...threatWeights, wClass: parseFloat(e.target.value) })}
                  style={{ accentColor: 'var(--accent-cyan)' }}
                />
              </div>

              {/* Proximity Weight */}
              <div className="flex-col" style={{ gap: '4px' }}>
                <div className="flex-row" style={{ justifyContent: 'space-between', fontSize: '0.9rem' }}>
                  <span className="text-muted">{t.wProxLabel}</span>
                  <span style={{ color: 'var(--accent-cyan)', fontWeight: 'bold' }}>{threatWeights.wProx.toFixed(2)}</span>
                </div>
                <input
                  type="range" min="0" max="1" step="0.05"
                  value={threatWeights.wProx}
                  onChange={(e) => setThreatWeights({ ...threatWeights, wProx: parseFloat(e.target.value) })}
                  style={{ accentColor: 'var(--accent-cyan)' }}
                />
              </div>

              {/* ETA Weight */}
              <div className="flex-col" style={{ gap: '4px' }}>
                <div className="flex-row" style={{ justifyContent: 'space-between', fontSize: '0.9rem' }}>
                  <span className="text-muted">{t.wEtaLabel}</span>
                  <span style={{ color: 'var(--accent-cyan)', fontWeight: 'bold' }}>{threatWeights.wEta.toFixed(2)}</span>
                </div>
                <input
                  type="range" min="0" max="1" step="0.05"
                  value={threatWeights.wEta}
                  onChange={(e) => setThreatWeights({ ...threatWeights, wEta: parseFloat(e.target.value) })}
                  style={{ accentColor: 'var(--accent-cyan)' }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '0.5rem' }}>
                {/* Danger Radius */}
                <div className="flex-col" style={{ gap: '4px' }}>
                  <label style={{ fontSize: '0.85rem' }} className="text-muted">{t.rDangerLabel}</label>
                  <input
                    type="number" className="config-input"
                    value={threatWeights.rDanger}
                    onChange={(e) => setThreatWeights({ ...threatWeights, rDanger: parseInt(e.target.value) || 100 })}
                  />
                </div>
                {/* Danger ETA */}
                <div className="flex-col" style={{ gap: '4px' }}>
                  <label style={{ fontSize: '0.85rem' }} className="text-muted">{t.tDangerLabel}</label>
                  <input
                    type="number" className="config-input"
                    value={threatWeights.tDanger}
                    onChange={(e) => setThreatWeights({ ...threatWeights, tDanger: parseInt(e.target.value) || 10 })}
                  />
                </div>
              </div>
            </div>

            {/* Defense Zones List and Actions */}
            <div className="flex-col" style={{ gap: '1rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1.5rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <ShieldAlert size={18} color="var(--accent-cyan)" /> {t.defenseZonesLabel}
              </h3>

              <div className="flex-col" style={{ gap: '0.75rem', maxHeight: '20vh', overflowY: 'auto' }}>
                {defenseZones.length === 0 ? (
                  <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-secondary)', background: 'rgba(0,0,0,0.2)', borderRadius: '6px' }}>
                    {t.noDefenseZones}
                  </div>
                ) : (
                  defenseZones.map((zone) => (
                    <div key={zone.id} style={{ background: 'rgba(0,0,0,0.3)', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid rgba(0, 229, 255, 0.2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ width: '12px', height: '12px', borderRadius: '3px', background: zone.color }} />
                        <span style={{ fontWeight: 'bold', color: '#fff' }}>{zone.name}</span>
                      </div>
                      <button
                        onClick={() => setDefenseZones(defenseZones.filter(z => z.id !== zone.id))}
                        style={{ background: 'transparent', border: 'none', color: 'var(--accent-red)', cursor: 'pointer' }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))
                )}
              </div>

              <button
                onClick={() => { setIsDrawingDefenseZone(true); setShowAdminModal(false); }}
                style={{ background: 'rgba(0, 229, 255, 0.1)', border: '1px dashed var(--accent-cyan)', padding: '0.75rem', color: 'var(--accent-cyan)', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                {t.drawDefenseZone}
              </button>
            </div>

            {/* ── Fusion Engine Section ── */}
            <div className="flex-col" style={{ gap: '1.25rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '1.5rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Activity size={18} color="var(--accent-cyan)" /> {t.fusionTitle}
              </h3>

              {/* Display Mode selector */}
              <div className="flex-col" style={{ gap: '0.5rem' }}>
                <span style={{ fontSize: '0.85rem' }} className="text-muted">{t.displayModeLabel}</span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
                  {(['detections', 'tracks', 'both'] as const).map(mode => (
                    <button key={mode}
                      onClick={() => setDisplayMode(mode)}
                      style={{
                        padding: '0.45rem 0.3rem',
                        borderRadius: '6px',
                        border: `1.5px solid ${displayMode === mode ? 'var(--accent-cyan)' : 'rgba(255,255,255,0.15)'}`,
                        background: displayMode === mode ? 'rgba(0,229,255,0.15)' : 'rgba(0,0,0,0.3)',
                        color: displayMode === mode ? 'var(--accent-cyan)' : 'var(--text-secondary)',
                        fontWeight: displayMode === mode ? 'bold' : 'normal',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                        textAlign: 'center'
                      }}
                    >
                      {mode === 'detections' ? t.modeDetections : mode === 'tracks' ? t.modeTracks : t.modeBoth}
                    </button>
                  ))}
                </div>
              </div>

              {/* Fusion parameters */}
              <div className="flex-col" style={{ gap: '0.75rem' }}>
                <span style={{ fontSize: '0.85rem' }} className="text-muted">{t.fusionParamsLabel}</span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                  {([
                    { key: 'maxAssocDistM',       label: t.maxDistLabel,        type: 'number', min: 10,  max: 1000 },
                    { key: 'maxAssocTimeSec',     label: t.maxTimeLabel,        type: 'number', min: 1,   max: 60 },
                    { key: 'minDetectionsToConfirm', label: t.minConfirmLabel, type: 'number', min: 1,   max: 10 },
                    { key: 'maxHeadingDiffDeg',   label: t.maxHeadingLabel,     type: 'number', min: 10,  max: 180 },
                    { key: 'maxSpeedRatioFactor', label: t.maxSpeedRatioLabel,  type: 'number', min: 1.1, max: 10,  step: 0.1 },
                    { key: 'wPosition',           label: t.wPositionLabel,      type: 'number', min: 0,   max: 1,   step: 0.1 },
                    { key: 'wVelocity',           label: t.wVelocityLabel,      type: 'number', min: 0,   max: 1,   step: 0.1 },
                  ] as Array<{ key: string; label: string; type: string; min?: number; max?: number; step?: number }>).map(param => (
                    <div key={param.key} className="flex-col" style={{ gap: '2px' }}>
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{param.label}</label>
                      <input
                        type="number"
                        className="config-input"
                        min={param.min}
                        max={param.max}
                        step={param.step ?? 1}
                        defaultValue={(fusionConfigState as any)[param.key]}
                        onBlur={async (e) => {
                          const val = param.step && param.step < 1 ? parseFloat(e.target.value) : parseInt(e.target.value, 10);
                          if (!isNaN(val)) {
                            const body: any = {};
                            body[param.key] = val;
                            await fetch('/api/fusion/config', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify(body)
                            });
                            setFusionConfigState((prev: any) => ({ ...prev, [param.key]: val }));
                          }
                        }}
                        style={{ fontSize: '0.85rem', padding: '0.25rem 0.5rem', textAlign: 'center' }}
                      />
                    </div>
                  ))}
                </div>

                {/* Advanced Kalman Sliders */}
                <div className="flex-col" style={{ gap: '0.75rem', marginTop: '0.5rem', padding: '0.5rem', border: '1px solid var(--border)', borderRadius: '4px' }}>
                  <span style={{ fontSize: '0.85rem' }} className="text-muted">אפשרויות החלקה מתקדמות</span>
                  
                  {/* Kalman R Slider */}
                  <div className="flex-col" style={{ gap: '2px' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t.kalmanRLabel}</label>
                    <input 
                      type="range" 
                      min="0" max="100" 
                      defaultValue={Math.round(100 * (Math.log10((fusionConfigState as any).kalmanR || 1e-5) - (-7)) / (-2 - (-7)))}
                      onChange={async (e) => {
                        const val = parseInt(e.target.value, 10);
                        const expMin = -7; const expMax = -2;
                        const rVal = Math.pow(10, expMin + (val / 100) * (expMax - expMin));
                        await fetch('/api/fusion/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kalmanR: rVal }) });
                        setFusionConfigState((prev: any) => ({ ...prev, kalmanR: rVal }));
                      }}
                      style={{ width: '100%', accentColor: 'var(--accent-cyan)', cursor: 'pointer' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: '#888' }}>
                      <span>דיוק מרבי (קופצני)</span>
                      <span>החלקה מרבית (יציב)</span>
                    </div>
                  </div>

                  {/* Kalman Q Slider */}
                  <div className="flex-col" style={{ gap: '2px' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t.kalmanQLabel}</label>
                    <input 
                      type="range" 
                      min="0" max="100" 
                      defaultValue={Math.round(100 * (Math.log10((fusionConfigState as any).kalmanQ || 1e-7) - (-9)) / (-3 - (-9)))}
                      onChange={async (e) => {
                        const val = parseInt(e.target.value, 10);
                        const expMin = -9; const expMax = -3;
                        const qVal = Math.pow(10, expMin + (val / 100) * (expMax - expMin));
                        await fetch('/api/fusion/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kalmanQ: qVal }) });
                        setFusionConfigState((prev: any) => ({ ...prev, kalmanQ: qVal }));
                      }}
                      style={{ width: '100%', accentColor: 'var(--accent-cyan)', cursor: 'pointer' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: '#888' }}>
                      <span>תנועה חלקה ואחידה</span>
                      <span>מגיב מהר לפניות חדות</span>
                    </div>
                  </div>
                </div>

                {/* Cross-radar toggle */}
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#fff', cursor: 'pointer', fontSize: '0.85rem' }}>
                  <input
                    type="checkbox"
                    checked={(fusionConfigState as any).crossRadarFusion ?? true}
                    onChange={async (e) => {
                      const val = e.target.checked;
                      await fetch('/api/fusion/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ crossRadarFusion: val })
                      });
                      setFusionConfigState((prev: any) => ({ ...prev, crossRadarFusion: val }));
                    }}
                    style={{ width: '1.1rem', height: '1.1rem', accentColor: 'var(--accent-cyan)' }}
                  />
                  {t.crossRadarLabel}
                </label>

                {/* Kinematic Classification override toggle */}
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#fff', cursor: 'pointer', fontSize: '0.85rem', marginTop: '4px' }}>
                  <input
                    type="checkbox"
                    checked={(fusionConfigState as any).enableKinematicClassification ?? false}
                    onChange={async (e) => {
                      const val = e.target.checked;
                      await fetch('/api/fusion/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ enableKinematicClassification: val })
                      });
                      setFusionConfigState((prev: any) => ({ ...prev, enableKinematicClassification: val }));
                    }}
                    style={{ width: '1.1rem', height: '1.1rem', accentColor: 'var(--accent-cyan)' }}
                  />
                  {t.kinematicClassLabel}
                </label>

                {/* Classification fusion mode */}
                <div className="flex-col" style={{ gap: '4px' }}>
                  <label style={{ fontSize: '0.75rem' }} className="text-muted">{t.classFusionModeLabel}</label>
                  <select
                    className="config-input"
                    defaultValue={(fusionConfigState as any).classificationFusionMode ?? 'max_prob'}
                    onChange={async (e) => {
                      const val = e.target.value;
                      await fetch('/api/fusion/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ classificationFusionMode: val })
                      });
                      setFusionConfigState((prev: any) => ({ ...prev, classificationFusionMode: val }));
                    }}
                    style={{ background: 'rgba(0,0,0,0.5)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', padding: '0.3rem', borderRadius: '4px', fontSize: '0.85rem' }}
                  >
                    <option value="max_prob">{lang === 'he' ? 'הסתברות מקסימלית (max_prob)' : 'Max Probability (max_prob)'}</option>
                    <option value="majority">{lang === 'he' ? 'רוב קולות (majority)' : 'Majority Vote (majority)'}</option>
                    <option value="latest">{lang === 'he' ? 'הדיווח האחרון (latest)' : 'Latest Detection (latest)'}</option>
                  </select>
                </div>
              </div>
            </div>

            <button className="glowing-btn active" onClick={() => setShowAdminModal(false)} style={{ marginTop: '0.5rem' }}>
              {t.close}
            </button>
          </div>
        </div>
      )}

      {/* PLAYBACK CONTROL BAR */}
      {appMode === 'playback' && selectedPlaybackFile && (
        <div style={{
          position: 'absolute',
          top: `${playbackPos.y}px`,
          left: `${playbackPos.x}px`,
          width: '600px',
          padding: '1rem',
          zIndex: 1000,
          pointerEvents: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
          background: 'rgba(10, 25, 41, 0.85)',
          border: '1px solid rgba(0, 229, 255, 0.3)',
          borderRadius: '12px',
          boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.5)',
          backdropFilter: 'blur(8px)',
          textAlign: lang === 'he' ? 'right' : 'left',
          direction: lang === 'he' ? 'rtl' : 'ltr'
        }}>
          {/* File information */}
          <div
            className="flex-row"
            onMouseDown={(e) => {
              setIsDraggingPlayback(true);
              setDragStartPlayback({
                x: e.clientX - playbackPos.x,
                y: e.clientY - playbackPos.y
              });
            }}
            style={{
              justifyContent: 'space-between',
              fontSize: '0.85rem',
              color: '#fff',
              borderBottom: '1px solid rgba(255,255,255,0.1)',
              paddingBottom: '0.4rem',
              cursor: 'move',
              userSelect: 'none'
            }}
          >
            <span style={{ fontWeight: 'bold', color: 'var(--accent-cyan)', wordBreak: 'break-all' }}>{selectedPlaybackFile}</span>
            <span>
              {Math.round(playbackTime / 1000)}s / {Math.round(playbackDuration / 1000)}s
            </span>
          </div>

          {/* Timeline slider */}
          <div className="flex-row" style={{ alignItems: 'center', width: '100%' }}>
            <input 
              type="range" 
              min="0" 
              max={playbackDuration || 100} 
              value={playbackTime} 
              onChange={(e) => handleSeek(parseInt(e.target.value, 10))} 
              style={{ flex: 1, accentColor: 'var(--accent-cyan)', cursor: 'pointer' }}
            />
          </div>

          {/* Action buttons (Play, Pause, Stop, Speeds) */}
          <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="flex-row" style={{ gap: '0.75rem' }}>
              <button 
                onClick={() => setIsPlaying(!isPlaying)} 
                style={{ 
                  background: isPlaying ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)', 
                  border: `1px solid ${isPlaying ? '#EF4444' : '#10B981'}`, 
                  color: isPlaying ? '#EF4444' : '#10B981', 
                  padding: '0.4rem 0.8rem', 
                  borderRadius: '6px', 
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontWeight: 'bold',
                  fontSize: '0.85rem'
                }}
              >
                {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                {isPlaying ? (lang === 'he' ? 'השהה' : 'Pause') : (lang === 'he' ? 'נגן' : 'Play')}
              </button>
              <button 
                onClick={() => { setIsPlaying(false); handleSeek(0); }} 
                style={{ 
                  background: 'rgba(255, 255, 255, 0.08)', 
                  border: '1px solid rgba(255, 255, 255, 0.2)', 
                  color: '#fff', 
                  padding: '0.4rem 0.8rem', 
                  borderRadius: '6px', 
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontWeight: 'bold',
                  fontSize: '0.85rem'
                }}
              >
                <Square size={14} />
                {lang === 'he' ? 'עצור' : 'Stop'}
              </button>
            </div>

            {/* Playback speed selector */}
            <div className="flex-row" style={{ gap: '0.25rem', alignItems: 'center' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginRight: '4px' }}>
                {lang === 'he' ? 'מהירות:' : 'Speed:'}
              </span>
              {[1, 2, 5, 10].map(speed => (
                <button 
                  key={`speed-${speed}`}
                  onClick={() => setPlaybackSpeed(speed)} 
                  style={{ 
                    padding: '0.25rem 0.5rem', 
                    borderRadius: '4px', 
                    border: '1px solid rgba(255,255,255,0.1)', 
                    background: playbackSpeed === speed ? 'var(--accent-cyan)' : 'transparent', 
                    color: playbackSpeed === speed ? '#000' : '#fff', 
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '0.75rem'
                  }}
                >
                  {speed}x
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* SIMULATION SETTINGS MODAL */}
      {showSimSettingsModal && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.8)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-panel" style={{ width: '400px', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', textAlign: lang === 'he' ? 'right' : 'left', direction: lang === 'he' ? 'rtl' : 'ltr' }}>
            <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '0.5rem' }}>
              <h2 style={{ margin: 0, color: '#FBBF24', fontSize: '1.25rem', fontWeight: 'bold' }}>
                {lang === 'he' ? 'הגדרות סימולציה' : 'Simulation Settings'}
              </h2>
              <button onClick={() => setShowSimSettingsModal(false)} style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '1.5rem' }}>&times;</button>
            </div>
            
            <div className="flex-col" style={{ gap: '1rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#fff', cursor: 'pointer' }}>
                <input 
                  type="checkbox" 
                  checked={simConfig.constantAsl} 
                  onChange={(e) => setSimConfig({ ...simConfig, constantAsl: e.target.checked })} 
                  style={{ width: '1.25rem', height: '1.25rem', accentColor: '#FBBF24' }} 
                />
                <span style={{ fontWeight: 'bold' }}>
                  {lang === 'he' ? 'שמירה על גובה גילויים (ASL/מעפ"י) אחיד' : 'Maintain constant Altitude (ASL) for targets'}
                </span>
              </label>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: 0, lineHeight: '1.4' }}>
                {lang === 'he' 
                  ? 'כאשר אפשרות זו פעילה, גובה המטרות המדומות יישאר קבוע לאורך כל זמן הטיסה ולא יתבצעו סחיפות גובה אקראיות.'
                  : 'When active, simulated target altitude stays completely constant without any random height drift.'}
              </p>
            </div>

            <button className="glowing-btn active" onClick={() => setShowSimSettingsModal(false)} style={{ marginTop: '0.5rem', background: '#FBBF24', color: '#000' }}>
              {t.close}
            </button>
          </div>
        </div>
      )}

      {/* RECORDING RENAME MODAL */}
      {showRenameModal && fileToRename && (
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="glass-panel" style={{ width: '450px', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem', textAlign: lang === 'he' ? 'right' : 'left', direction: lang === 'he' ? 'rtl' : 'ltr' }}>
            <div className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '0.5rem' }}>
              <h2 style={{ margin: 0, color: 'var(--accent-cyan)', fontSize: '1.25rem', fontWeight: 'bold' }}>
                {lang === 'he' ? 'שמירת קובץ הקלטה' : 'Save Recording File'}
              </h2>
            </div>
            
            <div className="flex-col" style={{ gap: '0.5rem' }}>
              <label className="text-muted" style={{ fontSize: '0.9rem' }}>
                {lang === 'he' ? 'הקלטה הסתיימה בהצלחה. בחר שם מותאם עבור הקובץ (או שמור בשם המקורי):' : 'Recording completed. Choose a custom file name (or keep default):'}
              </label>
              <input 
                type="text" 
                className="config-input" 
                value={newFileNameInput} 
                onChange={(e) => setNewFileNameInput(e.target.value)} 
                placeholder="my_radar_test"
                style={{ direction: 'ltr', fontSize: '1rem', fontWeight: 'bold' }}
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {lang === 'he' ? `שם ברירת מחדל: ${fileToRename.defaultName}` : `Default name: ${fileToRename.defaultName}`}
              </span>
            </div>

            <div className="flex-row" style={{ gap: '1rem', marginTop: '0.5rem' }}>
              <button 
                onClick={() => setShowRenameModal(false)} 
                style={{ flex: 1, padding: '0.5rem', borderRadius: '4px', background: 'transparent', border: '1px solid #fff', color: '#fff', cursor: 'pointer' }}
              >
                {lang === 'he' ? 'השאר שם מקורי' : 'Keep Default Name'}
              </button>
              <button 
                onClick={handleRenameFile} 
                style={{ flex: 1, padding: '0.5rem', borderRadius: '4px', background: 'var(--accent-cyan)', border: 'none', color: '#000', fontWeight: 'bold', cursor: 'pointer' }}
              >
                {lang === 'he' ? 'שמור שם מותאם' : 'Save Custom Name'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DYNAMIC STYLES FOR REC PULSE */}
      <style>{`
        @keyframes pulse-red {
          0% { opacity: 1; }
          50% { opacity: 0.35; }
          100% { opacity: 1; }
        }
        .pulse-red {
          animation: pulse-red 1s infinite;
        }
        @keyframes pulse-alert-border {
          0% { box-shadow: 0 0 8px rgba(239, 68, 68, 0.4); }
          50% { box-shadow: 0 0 18px rgba(239, 68, 68, 0.8); }
          100% { box-shadow: 0 0 8px rgba(239, 68, 68, 0.4); }
        }
        .pulse-alert-border {
          animation: pulse-alert-border 1.5s infinite;
        }
        @keyframes blink-dot {
          0% { opacity: 1; }
          50% { opacity: 0.2; }
          100% { opacity: 1; }
        }
        .blink-dot {
          animation: blink-dot 0.8s infinite;
        }
      `}</style>
    </div>
  );
}



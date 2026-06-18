#!/usr/bin/env python3
"""
MAVLink GPS and Heading Reader for Mitzpe Metzoda.
Reads GLOBAL_POSITION_INT / GPS_RAW_INT (position + heading) and VFR_HUD (heading backup)
from an ArduPilot/PX4 flight controller via serial port and streams JSON to stdout.
"""
import sys
import json
import time
import math
import argparse
import logging

logging.getLogger("pymavlink").setLevel(logging.CRITICAL)

try:
    from pymavlink import mavutil
except ImportError:
    print(json.dumps({"error": "pymavlink not installed. Run: pip install pymavlink"}), flush=True)
    sys.exit(1)

MAVLINK_MSG_ID_GLOBAL_POSITION_INT = 33
MAVLINK_MSG_ID_GPS_RAW_INT         = 24
MAVLINK_MSG_ID_VFR_HUD             = 74

def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port",     required=True)
    parser.add_argument("--baud",     type=int, default=115200)
    parser.add_argument("--radar-id", type=int, required=True)
    parser.add_argument("--mode",     choices=["stationary", "mobile"], default="mobile")
    return parser.parse_args()


def request_streams(connection):
    tgt_sys  = connection.target_system
    tgt_comp = connection.target_component
    # Legacy stream request (ArduPilot < 4.0)
    for stream_id in [2, 6]:  # POSITION, EXTRA1
        connection.mav.request_data_stream_send(tgt_sys, tgt_comp, stream_id, 4, 1)
    # Modern SET_MESSAGE_INTERVAL (ArduPilot >= 4.0, 250ms = 4Hz)
    for msg_id in [MAVLINK_MSG_ID_GLOBAL_POSITION_INT,
                   MAVLINK_MSG_ID_GPS_RAW_INT,
                   MAVLINK_MSG_ID_VFR_HUD]:
        connection.mav.command_long_send(
            tgt_sys, tgt_comp, 511, 0,
            float(msg_id), 250000.0, 0, 0, 0, 0, 0
        )
    sys.stderr.write("[GPS] Stream requests sent.\n")
    sys.stderr.flush()


def main():
    args = parse_args()

    # ── Open serial port ──────────────────────────────────────────────────────
    sys.stderr.write(f"[GPS] Connecting to {args.port} at {args.baud} baud...\n")
    sys.stderr.flush()
    try:
        conn = mavutil.mavlink_connection(args.port, baud=args.baud)
    except Exception as e:
        print(json.dumps({"error": f"Failed to open {args.port}: {e}"}), flush=True)
        sys.exit(1)

    sys.stderr.write(f"[GPS] Port opened. Waiting for heartbeat...\n")
    sys.stderr.flush()

    # ── Wait for heartbeat ────────────────────────────────────────────────────
    try:
        conn.wait_heartbeat(timeout=10)
        sys.stderr.write(f"[GPS] Heartbeat OK (sysid={conn.target_system}). Requesting streams...\n")
        sys.stderr.flush()
        request_streams(conn)
    except Exception as e:
        sys.stderr.write(f"[GPS] Warning: heartbeat timeout ({e}). Continuing anyway...\n")
        sys.stderr.flush()

    # ── State ─────────────────────────────────────────────────────────────────
    last_lat     = None
    last_lng     = None
    last_alt     = None
    last_heading = None
    gps_locked   = False   # True after first fix in stationary mode

    last_emit_time = 0.0
    EMIT_INTERVAL  = 0.5   # emit every 500ms for snappier UI response

    sys.stderr.write("[GPS] Listening for position & heading...\n")
    sys.stderr.flush()

    try:
        while True:
            # Receive next message (short timeout keeps loop responsive)
            msg = conn.recv_match(blocking=True, timeout=0.2)
            if msg is None:
                # No message arrived — still check if it's time to emit
                pass
            else:
                msg_type = msg.get_type()

                # ── GLOBAL_POSITION_INT (preferred: lat/lng/alt + heading) ────
                if msg_type == 'GLOBAL_POSITION_INT':
                    lat     = msg.lat / 1e7
                    lng     = msg.lon / 1e7
                    alt     = msg.alt / 1000.0
                    hdg     = msg.hdg / 100.0 if msg.hdg != 65535 else None

                    if lat != 0.0 or lng != 0.0:
                        if not gps_locked:
                            last_lat, last_lng, last_alt = lat, lng, alt
                        if hdg is not None:
                            last_heading = hdg
                        sys.stderr.write(
                            f"[GPS] Position: {lat:.5f},{lng:.5f} alt={alt:.0f}m"
                            f" hdg={hdg}°{'  [LOCKED]' if gps_locked else ''}\n"
                        )
                        sys.stderr.flush()

                # ── GPS_RAW_INT (fallback: lat/lng/alt, COG instead of heading) ──
                elif msg_type == 'GPS_RAW_INT':
                    lat = msg.lat / 1e7
                    lng = msg.lon / 1e7
                    alt = msg.alt / 1000.0
                    cog = msg.cog / 100.0 if msg.cog != 65535 else None

                    if lat != 0.0 or lng != 0.0:
                        if not gps_locked:
                            last_lat, last_lng, last_alt = lat, lng, alt
                        if cog is not None and last_heading is None:
                            last_heading = cog
                        sys.stderr.write(
                            f"[GPS] GPS_RAW: {lat:.5f},{lng:.5f} alt={alt:.0f}m"
                            f" cog={cog}°\n"
                        )
                        sys.stderr.flush()

                # ── VFR_HUD (reliable compass heading even without GPS fix) ────
                elif msg_type == 'VFR_HUD':
                    last_heading = float(msg.heading)

                # ── ATTITUDE (yaw backup if VFR_HUD absent) ───────────────────
                elif msg_type == 'ATTITUDE':
                    if last_heading is None:
                        last_heading = (math.degrees(msg.yaw) + 360) % 360

            # ── Emit to Node.js ───────────────────────────────────────────────
            if last_heading is not None:
                now = time.time()
                if now - last_emit_time >= EMIT_INTERVAL:
                    payload = {
                        "radarId":   args.radar_id,
                        "lat":       round(last_lat, 7) if last_lat is not None else None,
                        "lng":       round(last_lng, 7) if last_lng is not None else None,
                        "alt":       round(last_alt, 1) if last_alt is not None else None,
                        "heading":   round(last_heading, 1),
                        "hasGpsFix": last_lat is not None
                    }
                    print(json.dumps(payload), flush=True)
                    last_emit_time = now

                    # Lock GPS position after first fix in stationary mode
                    if args.mode == "stationary" and last_lat is not None and not gps_locked:
                        gps_locked = True
                        sys.stderr.write(f"[GPS] Stationary mode: GPS position locked at {last_lat:.5f},{last_lng:.5f}\n")
                        sys.stderr.flush()

    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(json.dumps({"error": f"Read error: {e}"}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()

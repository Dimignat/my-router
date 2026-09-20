#!/usr/bin/env python3
"""Turn an audio file into a monophonic note sequence for the Fellow kettle buzzer.

The kettle exposes an undocumented debug command:

    GET /cli?cmd=buz <freq_hz> <duty> <duration_ms>

which drives its piezo at an arbitrary frequency. This script estimates the
melody of an audio file and emits it as `buz` arguments.

A piezo is monophonic, so only one note sounds at a time: this works well for
solo melodies, whistling or humming, and poorly for full mixes, where the
pitch tracker has to pick a single winner out of every chord.

No third-party modules are required for WAV input. Other formats need ffmpeg
on PATH, which is used to transcode to WAV first.

Usage:
    python3 audio2buz.py tune.wav                   # print the note table
    python3 audio2buz.py tune.mp3 --sh > play.sh    # emit a shell player
    python3 audio2buz.py tune.wav --play            # send it to the kettle

Tuning knobs worth reaching for, in rough order of usefulness:
    --min-note   raise it to merge warbly runs into steadier notes
    --silence    raise it if quiet passages come out as spurious notes
    --lo / --hi  narrow the range to the voice you actually want tracked
"""

import argparse
import array
import math
import os
import shutil
import subprocess
import sys
import tempfile
import wave

# The piezo has nothing useful below a few hundred Hz, so transcribed notes get
# folded into this range rather than dropped.
PIEZO_LO = 220.0
PIEZO_HI = 4000.0

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


# --- decoding ---------------------------------------------------------------

def decode_to_mono(path, target_rate=22050):
    """Return (samples, rate) as floats in -1..1, mono, at ~target_rate."""
    wav_path, tmp = path, None
    if not path.lower().endswith(".wav"):
        wav_path = tmp = _transcode(path, target_rate)
    try:
        with wave.open(wav_path, "rb") as w:
            channels, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
            raw = w.readframes(w.getnframes())
    finally:
        if tmp:
            os.unlink(tmp)

    samples = _to_floats(raw, width)
    if channels > 1:
        samples = [sum(samples[i:i + channels]) / channels
                   for i in range(0, len(samples) - channels + 1, channels)]

    # Decimate rather than resample properly: pitch tracking survives it, and
    # it keeps this dependency-free.
    if rate > target_rate * 1.5:
        step = int(rate / target_rate)
        samples, rate = samples[::step], rate // step
    return samples, rate


def _transcode(path, rate):
    if not shutil.which("ffmpeg"):
        sys.exit(
            f"error: {os.path.basename(path)} is not a WAV and ffmpeg is not installed.\n"
            "  brew install ffmpeg\n"
            "or convert it to WAV another way first."
        )
    fd, out = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", path,
         "-ac", "1", "-ar", str(rate), out],
        check=True,
    )
    return out


def _to_floats(raw, width):
    if width == 1:  # 8-bit WAV is unsigned
        return [(b - 128) / 128.0 for b in array.array("B", raw)]
    if width == 2:
        a = array.array("h")
        a.frombytes(raw)
        return [s / 32768.0 for s in a]
    if width == 4:
        a = array.array("i")
        a.frombytes(raw)
        return [s / 2147483648.0 for s in a]
    sys.exit(f"error: unsupported WAV sample width ({width * 8}-bit)")


# --- pitch detection --------------------------------------------------------

def detect_pitch(frame, rate, lo, hi):
    """Estimate f0 by autocorrelation. Returns Hz, or None if unvoiced.

    Normalised autocorrelation: for each candidate lag, how well the frame
    matches itself shifted by that lag. A periodic signal peaks at its period.
    """
    n = len(frame)
    lag_min = max(2, int(rate / hi))
    lag_max = min(n - 1, int(rate / lo))
    if lag_max <= lag_min:
        return None

    energy = sum(s * s for s in frame)
    if energy <= 0:
        return None

    best_lag, best_score = 0, 0.0
    prev = 0.0
    rising = False
    for lag in range(lag_min, lag_max + 1):
        corr = sum(frame[i] * frame[i + lag] for i in range(n - lag))
        norm = corr / energy
        # Skip the decaying shoulder of the zero-lag peak: only consider a lag
        # once the curve has started rising again, or every frame reads as the
        # lowest allowed pitch.
        if not rising:
            if norm > prev:
                rising = True
            prev = norm
            continue
        if norm > best_score:
            best_score, best_lag = norm, lag
        prev = norm

    if best_lag == 0 or best_score < 0.3:  # too weak to call voiced
        return None
    return rate / _parabolic(frame, best_lag, energy)


def _parabolic(frame, lag, energy):
    """Refine an integer lag to sub-sample precision via a 3-point fit."""
    def corr_at(k):
        if k < 1 or k >= len(frame):
            return 0.0
        return sum(frame[i] * frame[i + k] for i in range(len(frame) - k)) / energy

    y0, y1, y2 = corr_at(lag - 1), corr_at(lag), corr_at(lag + 1)
    denom = y0 - 2 * y1 + y2
    if denom == 0:
        return float(lag)
    return lag + 0.5 * (y0 - y2) / denom


def rms(frame):
    return math.sqrt(sum(s * s for s in frame) / len(frame)) if frame else 0.0


# --- note shaping -----------------------------------------------------------

def quantize(freq):
    """Snap a frequency to the nearest equal-tempered semitone (A4 = 440)."""
    midi = round(69 + 12 * math.log2(freq / 440.0))
    return midi, 440.0 * (2 ** ((midi - 69) / 12.0))


def midi_to_hz(midi):
    return 440.0 * (2 ** ((midi - 69) / 12.0))


def fold_into_range(freq, lo=PIEZO_LO, hi=PIEZO_HI):
    """Octave-shift a note until the piezo can actually sound it."""
    while freq < lo:
        freq *= 2
    while freq > hi:
        freq /= 2
    return freq


def note_name(midi):
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def transcribe(samples, rate, hop_ms, win_ms, lo, hi, silence, min_note_ms):
    """Frame the audio, detect a pitch per frame, then merge frames into notes."""
    hop = max(1, int(rate * hop_ms / 1000))
    win = max(hop * 2, int(rate * win_ms / 1000))

    frames = []  # (midi or None) per hop
    for start in range(0, max(0, len(samples) - win), hop):
        frame = samples[start:start + win]
        if rms(frame) < silence:
            frames.append(None)
            continue
        f0 = detect_pitch(frame, rate, lo, hi)
        frames.append(quantize(f0)[0] if f0 else None)

    return _merge(frames, hop_ms, min_note_ms)


def _merge(frames, hop_ms, min_note_ms):
    """Collapse runs of identical frames into notes, dropping ones too short.

    A dropped note becomes a rest rather than vanishing, so timing is kept.
    """
    notes, run_val, run_len = [], None, 0

    def flush():
        if run_len == 0:
            return
        ms = run_len * hop_ms
        if run_val is not None and ms < min_note_ms:
            notes.append((None, ms))  # too brief to be real: treat as silence
        else:
            notes.append((run_val, ms))

    for val in frames:
        if val == run_val:
            run_len += 1
        else:
            flush()
            run_val, run_len = val, 1
    flush()

    # Merge neighbouring rests left behind by the drop above.
    merged = []
    for midi, ms in notes:
        if merged and midi is None and merged[-1][0] is None:
            merged[-1] = (None, merged[-1][1] + ms)
        else:
            merged.append((midi, ms))
    return merged


# --- output -----------------------------------------------------------------

def emit_table(notes):
    print(f"{'#':>4}  {'note':<6} {'freq':>7}  {'ms':>6}")
    print("-" * 30)
    for i, (midi, ms) in enumerate(notes, 1):
        if midi is None:
            print(f"{i:>4}  {'rest':<6} {'-':>7}  {round(ms):>6}")
        else:
            hz = fold_into_range(midi_to_hz(midi))
            print(f"{i:>4}  {note_name(midi):<6} {round(hz):>7}  {round(ms):>6}")
    total = sum(ms for _, ms in notes) / 1000.0
    sounded = sum(1 for m, _ in notes if m is not None)
    print(f"\n{sounded} notes, {total:.1f}s total")


def emit_args(notes):
    """The freq:ms form, for pasting into the play() helper."""
    parts = []
    for midi, ms in notes:
        hz = 0 if midi is None else round(fold_into_range(midi_to_hz(midi)))
        parts.append(f"{hz}:{round(ms)}")
    print(" ".join(parts))


def emit_sh(notes, host, duty, gap_ms):
    print("#!/bin/sh")
    print("# Generated by audio2buz.py -- plays a melody on the Fellow kettle piezo.")
    print(f"K={host}")
    print(f"DUTY={duty}")
    print()
    print("note() {  # note <freq_hz> <ms>")
    print('  [ "$1" -gt 0 ] 2>/dev/null && \\')
    print('    curl -s -m 5 --get --data-urlencode "cmd=buz $1 $DUTY $2" \\')
    print('      "http://$K/cli" >/dev/null')
    print(f'  perl -e "select(undef,undef,undef,$2/1000 + {gap_ms / 1000.0})"')
    print("}")
    print()
    for midi, ms in notes:
        if midi is None:
            print(f"note 0 {round(ms)}    # rest")
        else:
            hz = round(fold_into_range(midi_to_hz(midi)))
            print(f"note {hz} {round(ms)}    # {note_name(midi)}")


def play(notes, host, duty, gap_ms, timeout=5):
    import time
    import urllib.parse
    import urllib.request

    for midi, ms in notes:
        if midi is not None:
            hz = round(fold_into_range(midi_to_hz(midi)))
            q = urllib.parse.urlencode({"cmd": f"buz {hz} {duty} {round(ms)}"})
            try:
                urllib.request.urlopen(f"http://{host}/cli?{q}", timeout=timeout).read()
            except Exception as exc:
                sys.exit(f"error: kettle at {host} did not answer: {exc}")
        # buz returns immediately, so the caller has to wait out the note.
        time.sleep(ms / 1000.0 + gap_ms / 1000.0)


def main():
    p = argparse.ArgumentParser(
        description="Convert audio into a note sequence for the kettle's buz command.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Works best on a solo melody: humming, whistling, or a single instrument.",
    )
    p.add_argument("audio", help="input file (WAV, or anything ffmpeg reads)")
    p.add_argument("--host", default="192.168.2.120", help="kettle IP")
    p.add_argument("--duty", type=int, default=4096,
                   help="PWM duty 0-8191; ~4096 is loudest, lower is quieter")
    p.add_argument("--gap", type=float, default=60,
                   help="ms of silence between notes, so repeats stay distinct")
    p.add_argument("--hop", type=float, default=20, help="ms between analysis frames")
    p.add_argument("--window", type=float, default=60, help="ms per analysis frame")
    p.add_argument("--lo", type=float, default=80, help="lowest pitch to look for (Hz)")
    p.add_argument("--hi", type=float, default=1200, help="highest pitch to look for (Hz)")
    p.add_argument("--silence", type=float, default=0.02, help="RMS below this is a rest")
    p.add_argument("--min-note", type=float, default=80,
                   help="ms; shorter notes become rests")
    out = p.add_mutually_exclusive_group()
    out.add_argument("--args", action="store_true", help="emit freq:ms pairs on one line")
    out.add_argument("--sh", action="store_true", help="emit a standalone shell player")
    out.add_argument("--play", action="store_true", help="send straight to the kettle")
    a = p.parse_args()

    if not os.path.exists(a.audio):
        sys.exit(f"error: no such file: {a.audio}")

    samples, rate = decode_to_mono(a.audio)
    if not samples:
        sys.exit("error: no audio decoded")

    notes = transcribe(samples, rate, a.hop, a.window, a.lo, a.hi, a.silence, a.min_note)
    if not any(m is not None for m, _ in notes):
        sys.exit("error: no pitched notes found -- try lowering --silence "
                 "or widening --lo/--hi")

    if a.sh:
        emit_sh(notes, a.host, a.duty, a.gap)
    elif a.args:
        emit_args(notes)
    elif a.play:
        play(notes, a.host, a.duty, a.gap)
    else:
        emit_table(notes)


if __name__ == "__main__":
    main()

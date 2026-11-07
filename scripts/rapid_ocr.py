#!/usr/bin/env python3
# RapidOCR (PP-OCRv4 ONNX, local CPU) bridge for OneLink.
# One-shot:  rapid_ocr.py IMAGE  -> one JSON line {"text":..., "avgConf":0-100}
# Server:    rapid_ocr.py --serve -> reads image paths from stdin, answers one JSON line each.
# No network, no accounts; models load once in --serve mode.
import sys, json
def read_one(ocr, path):
    result, _ = ocr(path)
    if not result:
        return {"text": "", "avgConf": 0}
    dets = []
    for box, text, conf in result:
        yc = sum(p[1] for p in box) / 4.0
        xc = sum(p[0] for p in box) / 4.0
        dets.append((yc, xc, text, conf))
    dets.sort()
    rows = []
    for yc, xc, text, conf in dets:
        if rows and abs(yc - rows[-1][0]) <= 14:
            rows[-1][1].append((xc, text)); rows[-1][2].append(conf)
            rows[-1][0] = (rows[-1][0] * (len(rows[-1][1]) - 1) + yc) / len(rows[-1][1])
        else:
            rows.append([yc, [(xc, text)], [conf]])
    lines, confs = [], []
    for yc, toks, cs in rows:
        toks.sort()
        lines.append(' '.join(t for _, t in toks))
        confs.extend(cs)
    avg = (sum(confs) / len(confs) * 100) if confs else 0
    return {"text": "\n".join(lines), "avgConf": round(avg, 1)}
def main():
    from rapidocr_onnxruntime import RapidOCR
    ocr = RapidOCR()
    if len(sys.argv) > 1 and sys.argv[1] == '--serve':
        while True:
            line = sys.stdin.readline()
            if not line: break
            path = line.strip()
            if not path: continue
            try: out = read_one(ocr, path)
            except Exception: out = {"text": "", "avgConf": 0}
            sys.stdout.write(json.dumps(out) + '\n'); sys.stdout.flush()
    else:
        print(json.dumps(read_one(ocr, sys.argv[1])))
if __name__ == '__main__':
    main()

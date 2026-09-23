#!/usr/bin/env python3
"""Extract per-page, per-line text from a PDF, with x-position and font size.

Enough of a PDF reader to handle the lecture slides and handouts that end up in
unparsed_pdfs/, without needing poppler or any third-party library:

  - object streams and the page tree, so pages come out in reading order
  - /ToUnicode CMaps, plus the embedded TrueType cmap for Identity-H subsets
    whose /ToUnicode is only a stub (PowerPoint writes these)
  - TJ kerning, so words don't come out l e t t e r s p a c e d
  - line reconstruction from the text matrix, so side-by-side text boxes and
    table columns stay separate instead of being interleaved

Each output line is prefixed with its font size and x offset, which is what
makes the dump usable: the largest size on a page is its title, and the x
offsets give you the bullet nesting levels.

Limitation worth knowing: equations set in math fonts (Cambria Math and
friends) usually have a sparse /ToUnicode covering the operators but not the
italic variables, and those subset fonts carry no post table. Operators,
relations and structure survive; the variable letters do not. Expect to
reconstruct formulas from the surrounding prose rather than to lift them.

Usage:
  python3 pdftext.py FILE.pdf                 # whole document
  python3 pdftext.py FILE.pdf --pages 1,4,7   # just those pages
  python3 pdftext.py FILE.pdf --forms         # also read Form XObjects
  python3 pdftext.py FILE.pdf --plain         # drop the size/position prefix

--forms pulls in text drawn inside Form XObjects, which is where diagram
labels and figure captions usually live. It is off by default because it also
pulls in a page's decorative furniture.
"""
import argparse, re, sys, zlib

# ---------- object layer ----------

def inflate(raw, obj_body):
    if b'/FlateDecode' in obj_body:
        try:
            return zlib.decompress(raw)
        except Exception:
            try:
                return zlib.decompressobj().decompress(raw)
            except Exception:
                return b''
    return raw

class PDF:
    def __init__(self, path):
        self.data = open(path, 'rb').read()
        self.objs = {}          # num -> (body_bytes, stream_bytes or None)
        self._scan_objects()
        self._expand_objstms()

    def _scan_objects(self):
        for m in re.finditer(rb'(?<![0-9])(\d+)\s+(\d+)\s+obj\b', self.data):
            num = int(m.group(1))
            start = m.end()
            end = self.data.find(b'endobj', start)
            if end < 0:
                continue
            chunk = self.data[start:end]
            sm = re.search(rb'stream\r?\n', chunk)
            if sm:
                body = chunk[:sm.start()]
                se = chunk.find(b'endstream', sm.end())
                raw = chunk[sm.end():se if se >= 0 else len(chunk)]
                self.objs[num] = (body, inflate(raw, body))
            else:
                self.objs[num] = (chunk, None)

    def _expand_objstms(self):
        for num, (body, stream) in list(self.objs.items()):
            if b'/ObjStm' not in body or not stream:
                continue
            n = int(re.search(rb'/N\s+(\d+)', body).group(1))
            first = int(re.search(rb'/First\s+(\d+)', body).group(1))
            header = stream[:first].split()
            for i in range(n):
                onum, off = int(header[2 * i]), int(header[2 * i + 1])
                nxt = int(header[2 * i + 3]) if i + 1 < n else len(stream) - first
                if onum not in self.objs:
                    self.objs[onum] = (stream[first + off: first + nxt], None)

    def get(self, num):
        return self.objs.get(num, (b'', None))

    def deref(self, token):
        """Resolve '12 0 R' to that object's body; pass dicts/arrays through."""
        m = re.match(rb'\s*(\d+)\s+\d+\s+R\s*$', token or b'')
        if m:
            return self.get(int(m.group(1)))[0]
        return token

    # ---------- page tree ----------

    def pages(self):
        cat = None
        for num, (body, _) in self.objs.items():
            if b'/Type' in body and re.search(rb'/Type\s*/Catalog', body):
                cat = body
                break
        order = []
        if cat:
            m = re.search(rb'/Pages\s+(\d+)\s+\d+\s+R', cat)
            if m:
                self._walk(int(m.group(1)), order, {})
        if not order:  # fall back to file order
            for num, (body, _) in sorted(self.objs.items()):
                if re.search(rb'/Type\s*/Page(?![sA-Za-z])', body):
                    order.append((num, {}))
        return order

    def _walk(self, num, order, inherited, depth=0):
        if depth > 50:
            return
        body = self.get(num)[0]
        inh = dict(inherited)
        rm = re.search(rb'/Resources\s*(\d+\s+\d+\s+R|<<)', body)
        if rm:
            inh['Resources'] = self._dict_at(body, rm.start())
        if re.search(rb'/Type\s*/Page(?![sA-Za-z])', body):
            order.append((num, inh))
            return
        kids = re.search(rb'/Kids\s*\[(.*?)\]', body, re.S)
        if not kids:
            return
        for k in re.finditer(rb'(\d+)\s+\d+\s+R', kids.group(1)):
            self._walk(int(k.group(1)), order, inh, depth + 1)

    def _dict_at(self, body, pos):
        """Grab the value after /Key at pos: either a ref or a balanced <<...>>."""
        seg = body[pos:]
        m = re.match(rb'/\w+\s*(\d+\s+\d+\s+R)', seg)
        if m:
            return self.deref(m.group(1))
        start = seg.find(b'<<')
        if start < 0:
            return b''
        depth, i = 0, start
        while i < len(seg) - 1:
            if seg[i:i + 2] == b'<<':
                depth += 1; i += 2; continue
            if seg[i:i + 2] == b'>>':
                depth -= 1; i += 2
                if depth == 0:
                    return seg[start:i]
                continue
            i += 1
        return seg[start:]

    def page_content(self, num, forms=False):
        body = self.get(num)[0]
        m = re.search(rb'/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)', body)
        out = []
        if m:
            for r in re.findall(rb'(\d+)\s+\d+\s+R', m.group(1)):
                out.append(self.get(int(r))[1] or b'')
        if forms:
            # Diagram labels usually live in Form XObjects, not the page stream.
            res = b''
            rm = re.search(rb'/Resources\s*(\d+\s+\d+\s+R|<<)', body)
            if rm:
                res = self._dict_at(body, rm.start())
            xm = re.search(rb'/XObject\s*(\d+\s+\d+\s+R|<<)', res)
            if xm:
                xd = self._dict_at(res, xm.start())
                for m2 in re.finditer(rb'/[A-Za-z0-9#+.\-]+\s+(\d+)\s+\d+\s+R', xd):
                    xnum = int(m2.group(1))
                    xbody, xstream = self.get(xnum)
                    if xstream and re.search(rb'/Subtype\s*/Form', xbody):
                        out.append(xstream)
        return b'\n'.join(out)

    def page_fonts(self, num, inherited):
        body = self.get(num)[0]
        res = b''
        rm = re.search(rb'/Resources\s*(\d+\s+\d+\s+R|<<)', body)
        if rm:
            res = self._dict_at(body, rm.start())
        if not res:
            res = inherited.get('Resources', b'')
        fonts = {}
        fm = re.search(rb'/Font\s*(\d+\s+\d+\s+R|<<)', res)
        if not fm:
            return fonts
        fdict = self._dict_at(res, fm.start())
        for m in re.finditer(rb'/([A-Za-z0-9#+.\-]+)\s+(\d+)\s+\d+\s+R', fdict):
            num = int(m.group(2))
            fbody = self.get(num)[0]
            # Only composite (Identity-H) fonts address glyphs by GID; simple
            # TrueType/Type1 fonts use character codes, so leave them to latin-1.
            is_cid = bool(re.search(rb'/Subtype\s*/Type0', fbody))
            if is_cid:
                mp = self.glyph_map(num) or {}
                mp.update(self.tounicode(num) or {})   # explicit ToUnicode wins
            else:
                mp = self.tounicode(num) or {}
            fonts[m.group(1).decode('latin-1')] = (mp or None, is_cid)
        return fonts

    # ---------- embedded TrueType cmap (Identity-H subset fonts) ----------

    def glyph_map(self, fontnum):
        """CID/GID -> unicode, read from the embedded TrueType 'cmap' table.

        PowerPoint writes Identity-H subsets whose /ToUnicode only covers a
        couple of special glyphs, so the font program is the real source.
        """
        body = self.get(fontnum)[0]
        cid_body = body
        m = re.search(rb'/DescendantFonts\s*\[?\s*(\d+)\s+\d+\s+R', body)
        if m:
            cid_body = self.get(int(m.group(1)))[0]
            # /DescendantFonts may point at an array object holding the real ref
            if b'/FontDescriptor' not in cid_body:
                inner = re.search(rb'\[\s*(\d+)\s+\d+\s+R', cid_body)
                if inner:
                    cid_body = self.get(int(inner.group(1)))[0]
            if not cid_body.strip():
                cid_body = body
        fd = re.search(rb'/FontDescriptor\s+(\d+)\s+\d+\s+R', cid_body)
        if not fd:
            return None
        desc = self.get(int(fd.group(1)))[0]
        ff = re.search(rb'/FontFile2\s+(\d+)\s+\d+\s+R', desc)
        if not ff:
            return None
        ttf = self.get(int(ff.group(1)))[1]
        if not ttf:
            return None
        return parse_ttf_cmap(ttf)

    def tounicode(self, fontnum):
        body = self.get(fontnum)[0]
        m = re.search(rb'/ToUnicode\s+(\d+)\s+\d+\s+R', body)
        if not m:
            # composite fonts hide it behind /DescendantFonts; simple fonts have none
            return None
        cmap = self.get(int(m.group(1)))[1] or b''
        mp = {}
        for b in re.finditer(rb'beginbfchar(.*?)endbfchar', cmap, re.S):
            for src, dst in re.findall(rb'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', b.group(1)):
                mp[int(src, 16)] = ''.join(
                    chr(int(dst[i:i + 4], 16)) for i in range(0, len(dst), 4))
        for b in re.finditer(rb'beginbfrange(.*?)endbfrange', cmap, re.S):
            for lo, hi, dst in re.findall(
                    rb'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', b.group(1)):
                lo, hi, d0 = int(lo, 16), int(hi, 16), int(dst, 16)
                for i in range(min(hi - lo + 1, 65536)):
                    mp[lo + i] = chr(d0 + i)
        return mp or None

# ---------- content stream tokenizer ----------

def _u16(b, o): return int.from_bytes(b[o:o + 2], 'big')
def _u32(b, o): return int.from_bytes(b[o:o + 4], 'big')

def parse_ttf_cmap(ttf):
    try:
        num_tables = _u16(ttf, 4)
        cmap_off = None
        for i in range(num_tables):
            rec = 12 + 16 * i
            if ttf[rec:rec + 4] == b'cmap':
                cmap_off = _u32(ttf, rec + 8)
                break
        if cmap_off is None:
            return None
        best = None
        for i in range(_u16(ttf, cmap_off + 2)):
            rec = cmap_off + 4 + 8 * i
            pid, eid, off = _u16(ttf, rec), _u16(ttf, rec + 2), _u32(ttf, rec + 4)
            score = {(3, 10): 3, (3, 1): 2, (0, 3): 2, (0, 4): 2}.get((pid, eid), 1)
            if best is None or score > best[0]:
                best = (score, cmap_off + off)
        sub = best[1]
        fmt = _u16(ttf, sub)
        gid2uni = {}

        def put(uni, gid):
            if gid and (gid not in gid2uni or uni < gid2uni[gid]):
                gid2uni[gid] = uni

        if fmt == 4:
            segx2 = _u16(ttf, sub + 6)
            seg = segx2 // 2
            ends = sub + 14
            starts = ends + segx2 + 2
            deltas = starts + segx2
            ranges = deltas + segx2
            for s in range(seg):
                end, start = _u16(ttf, ends + 2 * s), _u16(ttf, starts + 2 * s)
                delta, ro = _u16(ttf, deltas + 2 * s), _u16(ttf, ranges + 2 * s)
                if start > end or end == 0xFFFF and start == 0xFFFF:
                    continue
                for c in range(start, min(end, 0xFFFE) + 1):
                    if ro == 0:
                        put(c, (c + delta) & 0xFFFF)
                    else:
                        gi = ranges + 2 * s + ro + 2 * (c - start)
                        g = _u16(ttf, gi)
                        if g:
                            put(c, (g + delta) & 0xFFFF)
        elif fmt == 12:
            n = _u32(ttf, sub + 12)
            for g in range(n):
                rec = sub + 16 + 12 * g
                sc, ec, sg = _u32(ttf, rec), _u32(ttf, rec + 4), _u32(ttf, rec + 8)
                for k in range(min(ec - sc + 1, 4096)):
                    put(sc + k, sg + k)
        elif fmt == 6:
            first, cnt = _u16(ttf, sub + 6), _u16(ttf, sub + 8)
            for k in range(cnt):
                put(first + k, _u16(ttf, sub + 10 + 2 * k))
        elif fmt == 0:
            for c in range(256):
                put(c, ttf[sub + 6 + c])
        else:
            return None
        return {g: chr(u) for g, u in gid2uni.items()
                if not (0xD800 <= u <= 0xDFFF) and u <= 0x10FFFF}
    except Exception:
        return None

# ---------- content stream tokenizer ----------

def tokenize(s):
    i, n = 0, len(s)
    while i < n:
        c = s[i:i + 1]
        if c in b' \t\r\n\f\x00':
            i += 1
        elif c == b'%':
            j = s.find(b'\n', i); i = n if j < 0 else j + 1
        elif c == b'(':
            depth, j, out = 1, i + 1, bytearray()
            while j < n and depth:
                ch = s[j:j + 1]
                if ch == b'\\':
                    nx = s[j + 1:j + 2]
                    esc = {b'n': b'\n', b'r': b'\r', b't': b'\t', b'b': b'\b',
                           b'f': b'\f', b'(': b'(', b')': b')', b'\\': b'\\'}
                    if nx in esc:
                        out += esc[nx]; j += 2
                    elif nx.isdigit():
                        oct_ = s[j + 1:j + 4]
                        k = 0
                        while k < 3 and oct_[k:k + 1].isdigit():
                            k += 1
                        out.append(int(oct_[:k], 8) & 0xFF); j += 1 + k
                    else:
                        j += 2
                    continue
                if ch == b'(':
                    depth += 1
                elif ch == b')':
                    depth -= 1
                    if not depth:
                        j += 1; break
                out += ch; j += 1
            yield ('str', bytes(out)); i = j
        elif c == b'<' and s[i + 1:i + 2] != b'<':
            j = s.find(b'>', i)
            h = re.sub(rb'[^0-9A-Fa-f]', b'', s[i + 1:j])
            if len(h) % 2:
                h += b'0'
            yield ('hex', bytes.fromhex(h.decode('ascii'))); i = j + 1
        elif s[i:i + 2] == b'<<':
            yield ('op', b'<<'); i += 2
        elif s[i:i + 2] == b'>>':
            yield ('op', b'>>'); i += 2
        elif c in b'[]':
            yield ('op', c); i += 1
        elif c == b'/':
            m = re.match(rb'/([^\s/\[\]()<>{}%]*)', s[i:])
            yield ('name', m.group(1)); i += m.end()
        else:
            m = re.match(rb'[-+.\d]+', s[i:])
            if m:
                try:
                    yield ('num', float(m.group(0).replace(b'--', b'-')))
                except ValueError:
                    yield ('num', 0.0)
                i += m.end()
            else:
                m = re.match(rb'[^\s/\[\]()<>{}%]+', s[i:])
                if not m:
                    i += 1; continue
                yield ('op', m.group(0)); i += m.end()

def decode_str(raw, cmap, is_cid):
    """raw is the string's bytes. is_cid means 2-byte codes (Identity-H)."""
    if cmap:
        if is_cid and len(raw) % 2 == 0:
            codes = [int.from_bytes(raw[i:i + 2], 'big') for i in range(0, len(raw), 2)]
        else:
            codes = list(raw)
        # Decide by how many codes the map covers, not by whether the result
        # looks blank: a correctly decoded lone space is blank but still right.
        hits = sum(1 for c in codes if c in cmap)
        if codes and hits == len(codes):
            return ''.join(cmap[c] for c in codes)
        if hits and hits >= len(codes) * 0.6:
            return ''.join(cmap.get(c, '') for c in codes)
    if is_cid and len(raw) % 2 == 0 and raw[0:1] == b'\x00':
        return raw.decode('utf-16-be', 'replace')
    return raw.decode('latin-1')

def page_lines(content, fonts):
    """Return [(y, x, size, text)] lines for one page's content stream."""
    frags = []
    stack = []
    tm = [1, 0, 0, 1, 0, 0]
    tlm = list(tm)
    size, leading, cmap, curfont, is_cid = 12.0, 0.0, None, None, False

    def pos():
        return tm[4], tm[5]

    def emit(txt):
        if not txt:
            return
        x, y = pos()
        frags.append([y, x, size, curfont, txt])

    ops = []
    for kind, val in tokenize(content):
        if kind in ('num', 'str', 'hex', 'name'):
            ops.append((kind, val)); continue
        if kind != 'op':
            continue
        op = val
        if op in (b'[', b']'):
            ops.append(('op', op))
            continue
        if op == b'BT':
            tm = [1, 0, 0, 1, 0, 0]; tlm = list(tm)
        elif op == b'Tf':
            if len(ops) >= 2:
                fname = ops[-2][1].decode('latin-1') if ops[-2][0] == 'name' else ''
                curfont = fname
                cmap, is_cid = fonts.get(fname, (None, False))
                try:
                    size = float(ops[-1][1])
                except Exception:
                    pass
        elif op == b'TL':
            leading = float(ops[-1][1]) if ops and ops[-1][0] == 'num' else leading
        elif op in (b'Td', b'TD'):
            if len(ops) >= 2:
                dx, dy = float(ops[-2][1]), float(ops[-1][1])
                if op == b'TD':
                    leading = -dy
                tlm[4] += dx * tlm[0] + dy * tlm[2]
                tlm[5] += dx * tlm[1] + dy * tlm[3]
                tm = list(tlm)
        elif op == b'Tm':
            if len(ops) >= 6:
                tlm = [float(ops[-6 + i][1]) for i in range(6)]
                tm = list(tlm)
        elif op == b'T*':
            tlm[4] -= leading * tlm[2]; tlm[5] -= leading * tlm[3]
            tm = list(tlm)
        elif op in (b'Tj', b"'", b'"'):
            if ops and ops[-1][0] in ('str', 'hex'):
                if op != b'Tj':
                    tlm[5] -= leading; tm = list(tlm)
                emit(decode_str(ops[-1][1], cmap, is_cid))
        elif op == b'TJ':
            # walk back to the matching '['
            i = len(ops) - 1
            while i >= 0 and not (ops[i][0] == 'op' and ops[i][1] == b'['):
                i -= 1
            buf = []
            for kind2, v2 in ops[i + 1:]:
                if kind2 in ('str', 'hex'):
                    buf.append(decode_str(v2, cmap, is_cid))
                elif kind2 == 'num' and v2 <= -170:   # kern big enough to be a space
                    if buf and not buf[-1].endswith(' '):
                        buf.append(' ')
            emit(''.join(buf))
        elif op == b'q':
            stack.append((list(tm), size, cmap, curfont, is_cid))
        elif op == b'Q':
            if stack:
                tm, size, cmap, curfont, is_cid = stack.pop()
                tm = list(tm)
        if op not in (b'[',):
            ops = []
    # Group fragments into lines: same baseline, same font, and close enough in x
    # that they continue each other. A big x-gap means a separate text box.
    frags = [f for f in frags if f[4].strip()]
    frags.sort(key=lambda f: (-round(f[0], 1), f[1]))
    out, cur = [], None
    for y, x, size, font, txt in frags:
        if cur is not None:
            same_line = abs(cur[0] - y) < 1.5 and cur[3] == font
            est_end = cur[1] + 0.52 * cur[2] * len(cur[4])
            if same_line and x - est_end < 1.6 * size:
                cur[4] += txt
                continue
        cur = [y, x, size, font, txt]
        out.append(cur)
    return [(r[0], r[1], r[2], r[4]) for r in out]

def main():
    ap = argparse.ArgumentParser(
        description='Dump the text of a PDF, one line per line of the page.')
    ap.add_argument('file', help='PDF to read')
    ap.add_argument('--pages', help='comma-separated page numbers (1-based); default all')
    ap.add_argument('--forms', action='store_true',
                    help='also read Form XObjects (diagram labels, figure captions)')
    ap.add_argument('--plain', action='store_true',
                    help='omit the font-size / x-position prefix')
    args = ap.parse_args()

    only = None
    if args.pages:
        try:
            only = {int(x) for x in args.pages.split(',') if x.strip()}
        except ValueError:
            ap.error('--pages wants comma-separated integers, e.g. --pages 1,4,7')

    pdf = PDF(args.file)
    pages = pdf.pages()
    if not pages:
        print(f'{args.file}: no pages found', file=sys.stderr)
        return 1

    for idx, (num, inherited) in enumerate(pages, 1):
        if only and idx not in only:
            continue
        rows = page_lines(pdf.page_content(num, forms=args.forms),
                          pdf.page_fonts(num, inherited))
        rows = [r for r in rows if r[3].strip()]
        if not rows:
            continue
        print(f'\n───── page {idx}/{len(pages)} ─────')
        for _y, x, size, txt in rows:
            txt = re.sub(r'\s+', ' ', txt).strip()
            # Lone surrogates can survive a bad glyph map; keep the dump printable.
            txt = txt.encode('utf-8', 'replace').decode('utf-8')
            # Symbol-font bullets have no ToUnicode and arrive as glyph codes.
            if re.fullmatch(r'(00[0-9A-Fa-f]{2}\s*)+', txt):
                txt = '-'
            if not txt:
                continue
            print(txt if args.plain else f'[{size:4.0f}pt x{x:6.0f}] {txt}')
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except BrokenPipeError:
        # Normal when piped into head/less: drop stdout so Python's shutdown
        # flush doesn't report the broken pipe again.
        import os
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        sys.exit(0)

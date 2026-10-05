"""ครัวคุณหลี Orders - the AI-board version of the lee-orders site (stdlib only).

Read side:  the same round JSON the GitHub Pages site encrypts, synced in plaintext into
            /data/sync by _local/scripts/board_sync.py (index.json, orders/<id>.json,
            address-book.json). This app never parses Instagram; it only shows and annotates.
Write side: SQLite /data/lee.db - things only Khun Lee can supply:
            * answers to the open questions on a round (structured `questions` + every ⚠️ note)
            * per-order status: paid / shipped / shipping-fee override
            * free-text notes and instructions (general, per round, or per order),
              which Nick marks done with a reply
            Every write is also appended to `events`, which `python server.py inbox` prints for
            the "check her reply" workflow.

Identity comes from Caddy forward_auth headers (Remote-User / Remote-Name / Remote-Groups);
this container publishes no port and is reachable only through Caddy.

HTTP :8080
  GET  /                         the app (index.html, app.js, style.css)
  GET  /api/me
  GET  /api/rounds               round list + per-round summary
  GET  /api/round/<id>           orders with totals, address, status; questions; notes; prep
  GET  /api/round/<id>/shipping.csv
  GET  /api/customers            every customer across all rounds
  GET  /api/customer/<handle>
  GET  /api/notes                general notes (and all open notes)
  POST /api/status   {round, key, paid?, shipped?, fee?}
  POST /api/answer   {round, qid, answer}
  POST /api/note     {text, round?, key?}
  POST /api/note/<id>/done  {reply?}        admins only
CLI
  python server.py inbox [since_epoch]   JSON of events + open notes since a timestamp
"""
import csv, hashlib, io, json, os, re, sqlite3, sys, threading, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA = os.environ.get('LEE_DATA', '/data')
SYNC = os.path.join(DATA, 'sync')
DB = os.path.join(DATA, 'lee.db')
HERE = os.path.dirname(os.path.abspath(__file__))
LOCK = threading.Lock()
STATIC = {'/': ('index.html', 'text/html; charset=utf-8'),
          '/index.html': ('index.html', 'text/html; charset=utf-8'),
          '/app.js': ('app.js', 'application/javascript; charset=utf-8'),
          '/style.css': ('style.css', 'text/css; charset=utf-8'),
          '/manifest.webmanifest': ('manifest.webmanifest', 'application/manifest+json'),
          '/icon-180.png': ('icon-180.png', 'image/png'),
          '/icon-512.png': ('icon-512.png', 'image/png')}


# ------------------------------------------------------------------ database
def db():
    c = sqlite3.connect(DB, timeout=60, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init_db():
    os.makedirs(DATA, exist_ok=True)
    with db() as c:
        c.executescript('''
        CREATE TABLE IF NOT EXISTS status(round_id TEXT, okey TEXT, paid INT DEFAULT 0, shipped INT DEFAULT 0,
            fee INT, by TEXT, at INT, PRIMARY KEY(round_id, okey));
        CREATE TABLE IF NOT EXISTS answers(round_id TEXT, qid TEXT, question TEXT, answer TEXT, by TEXT, at INT,
            PRIMARY KEY(round_id, qid));
        CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, at INT, by TEXT, round_id TEXT, okey TEXT,
            text TEXT, done INT DEFAULT 0, done_by TEXT, done_at INT, reply TEXT);
        CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, at INT, by TEXT, kind TEXT, round_id TEXT,
            okey TEXT, ref TEXT, payload TEXT);
        ''')


def log_event(c, by, kind, round_id=None, okey=None, ref=None, payload=None):
    c.execute('INSERT INTO events(at,by,kind,round_id,okey,ref,payload) VALUES(?,?,?,?,?,?,?)',
              (int(time.time()), by, kind, round_id, okey, ref,
               json.dumps(payload, ensure_ascii=False) if payload is not None else None))


# --------------------------------------------------------------- round data
_cache = {}


def load_json(path):
    try:
        m = os.path.getmtime(path)
    except OSError:
        return None
    hit = _cache.get(path)
    if hit and hit[0] == m:
        return hit[1]
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    _cache[path] = (m, data)
    return data


def index():
    return load_json(os.path.join(SYNC, 'index.json')) or {'orders': []}


def round_data(rid):
    if not re.fullmatch(r'[0-9A-Za-z\-]+', rid or ''):
        return None
    return load_json(os.path.join(SYNC, 'orders', rid + '.json'))


def addrbook():
    return load_json(os.path.join(SYNC, 'address-book.json')) or {'byUser': {}}


def norm_u(u):
    return re.sub(r'\s*\(.*?\)\s*$', '', str(u or '')).strip().lower()


def lookup_address(user, zip_):
    slots = addrbook().get('byUser', {}).get(norm_u(user))
    if not slots:
        return None
    keys = list(slots)
    if zip_ and zip_ in slots:
        return dict(slots[zip_], postal=zip_)
    if len(keys) == 1:
        return dict(slots[keys[0]], postal=keys[0])
    if zip_:
        for k in keys:
            if k[:2] == zip_[:2]:
                return dict(slots[k], postal=k, ambiguous=True)
    return dict(slots[keys[0]], postal=keys[0], ambiguous=True)


def prices(d):
    return {m['code']: m.get('price', 0) for m in d.get('menu', [])}


def item_total(items, pr):
    return sum((q or 0) * pr.get(k, 0) for k, q in items.items())


def ship_zone(d, o):
    """Mirrors shippingZone() in assets/js/order.js (73/74 = ต่างจังหวัด, Lee 24/9/2569)."""
    if 'มารับเอง' in (o.get('note') or ''):
        return 0, 'มารับเอง'
    metro = d.get('shippingMetroPrefixes') or ['10', '11', '12']
    z = o.get('zip') or ''
    if not z:
        return d.get('shippingDefault', 100), 'ไม่ระบุ ปณ. — ตรวจสอบ'
    if z[:2] in metro:
        return d.get('shippingBkk', d.get('shippingDefault', 100)), 'กทม./ปริมณฑล'
    return d.get('shippingUpcountry', 250), 'ต่างจังหวัด'


def okey(o, caption=False):
    return ('cap:' if caption else '') + o['user']


def questions(d):
    """Structured `questions` from the round def, plus every ⚠️ note as a free-text question."""
    qs = [dict(q, kind='choice') for q in (d.get('questions') or [])]
    for n in d.get('notes') or []:
        if isinstance(n, str) and n.startswith('⚠️'):
            qid = 'n:' + hashlib.sha1(n.encode('utf-8')).hexdigest()[:10]
            qs.append({'id': qid, 'text': n[2:].strip(), 'options': [], 'kind': 'note'})
    return qs


def round_view(rid):
    d = round_data(rid)
    if d is None:
        return None
    pr = prices(d)
    with db() as c:
        st = {r['okey']: dict(r) for r in c.execute('SELECT * FROM status WHERE round_id=?', (rid,))}
        ans = {r['qid']: dict(r) for r in c.execute('SELECT * FROM answers WHERE round_id=?', (rid,))}
        notes = [dict(r) for r in c.execute('SELECT * FROM notes WHERE round_id=? ORDER BY id DESC', (rid,))]
    orders = []
    for cap, lst in ((False, d.get('orders', [])), (True, d.get('captionOrders', []))):
        for o in lst:
            k = okey(o, cap)
            fee0, zone = ship_zone(d, o)
            s = st.get(k, {})
            fee = s.get('fee') if s.get('fee') is not None else fee0
            food = item_total(o.get('items', {}), pr)
            orders.append({
                'key': k, 'caption': cap, 'user': o['user'], 'zip': o.get('zip', ''),
                'items': o.get('items', {}), 'note': o.get('note'), 'remark': o.get('remark'),
                'comment': o.get('comment'), 'time': o.get('time'),
                'cancelled': bool(o.get('cancelled')), 'movedTo': o.get('movedTo'),
                'editedFrom': o.get('editedFrom'), 'normalizedFrom': o.get('normalizedFrom'),
                'food': food, 'fee': fee, 'feeAuto': fee0, 'zone': zone, 'total': food + fee,
                'paid': bool(s.get('paid')), 'shipped': bool(s.get('shipped')),
                'address': lookup_address(o['user'], o.get('zip')),
            })
    active = [o for o in orders if not o['cancelled']]
    prep = {}
    for o in active:
        for k, q in o['items'].items():
            prep[k] = prep.get(k, 0) + (q or 0)
    qs = questions(d)
    for q in qs:
        a = ans.get(q['id'])
        q['answer'] = a['answer'] if a else None
        q['answeredBy'] = a['by'] if a else None
        q['answeredAt'] = a['at'] if a else None
    return {
        'id': rid, 'title': d.get('title'), 'status': d.get('status'),
        'deliveryDateLabel': d.get('deliveryDateLabel'), 'deliveryDateFull': d.get('deliveryDateFull'),
        'popupTitle': d.get('popupTitle'), 'payment': d.get('payment', {}),
        'menu': d.get('menu', []), 'displayColumns': d.get('displayColumns') or [m['code'] for m in d.get('menu', [])],
        'parsedAt': d.get('parsedAt'), 'orders': orders, 'questions': qs, 'notes': notes,
        'prep': prep, 'roundNotes': d.get('notes', []),
        'summary': summarize(orders, qs, notes),
    }


def summarize(orders, qs, notes):
    act = [o for o in orders if not o['cancelled']]
    return {
        'orders': len(act), 'cancelled': len(orders) - len(act),
        'food': sum(o['food'] for o in act), 'fees': sum(o['fee'] for o in act),
        'paid': sum(1 for o in act if o['paid']), 'paidAmt': sum(o['total'] for o in act if o['paid']),
        'shipped': sum(1 for o in act if o['shipped']),
        'due': sum(1 for o in act if not o['paid']), 'dueAmt': sum(o['total'] for o in act if not o['paid']),
        'openQuestions': sum(1 for q in qs if not q.get('answer')),
        'openNotes': sum(1 for n in notes if not n['done']),
    }


def rounds_list():
    out = []
    for r in index().get('orders', []):
        v = round_view(r['id'])
        if v is None:
            continue
        out.append({'id': r['id'], 'title': r.get('title'), 'status': r.get('status'),
                    'deliveryDateLabel': r.get('deliveryDateLabel'), 'summary': v['summary']})
    return out


def customers():
    agg = {}
    for r in index().get('orders', []):
        d = round_data(r['id'])
        if not d:
            continue
        pr = prices(d)
        for o in d.get('orders', []) + d.get('captionOrders', []):
            if o.get('cancelled'):
                continue
            h = norm_u(o['user'])
            a = agg.setdefault(h, {'handle': h, 'orders': 0, 'food': 0, 'zips': {}, 'last': None, 'lastLabel': ''})
            a['orders'] += 1
            a['food'] += item_total(o.get('items', {}), pr)
            if o.get('zip'):
                a['zips'][o['zip']] = a['zips'].get(o['zip'], 0) + 1
            if a['last'] is None or r['id'] > a['last']:
                a['last'], a['lastLabel'] = r['id'], r.get('deliveryDateLabel', '')
                a['lastZip'] = o.get('zip') or a.get('lastZip')
    book = addrbook().get('byUser', {})
    for h, a in agg.items():
        a['known'] = h in book
        slot = next(iter(book.get(h, {}).values()), None)
        a['name'] = (slot or {}).get('name', '')
    return sorted(agg.values(), key=lambda a: (-a['orders'], a['handle']))


def customer(handle):
    h = norm_u(handle)
    hist = []
    for r in index().get('orders', []):
        d = round_data(r['id'])
        if not d:
            continue
        pr = prices(d)
        names = {m['code']: m.get('short') or m.get('name') for m in d.get('menu', [])}
        for cap, lst in ((False, d.get('orders', [])), (True, d.get('captionOrders', []))):
            for o in lst:
                if norm_u(o['user']) != h:
                    continue
                hist.append({'round': r['id'], 'label': r.get('deliveryDateLabel', ''), 'status': r.get('status'),
                             'key': okey(o, cap), 'zip': o.get('zip', ''), 'cancelled': bool(o.get('cancelled')),
                             'items': [[names.get(k, k), q] for k, q in o.get('items', {}).items() if q],
                             'food': item_total(o.get('items', {}), pr), 'note': o.get('note')})
    hist.sort(key=lambda x: x['round'], reverse=True)
    addrs = [dict(v, postal=k) for k, v in addrbook().get('byUser', {}).get(h, {}).items()]
    return {'handle': h, 'history': hist, 'addresses': addrs}


def shipping_csv(rid):
    v = round_view(rid)
    names = {m['code']: m.get('short') or m.get('name') for m in v['menu']}
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(['IG', 'ชื่อ', 'โทร', 'ที่อยู่', 'ปณ.', 'พิกัด', 'รายการ', 'ยอดสินค้า', 'ค่าส่ง', 'รวม', 'จ่ายแล้ว', 'หมายเหตุ'])
    for o in sorted((o for o in v['orders'] if not o['cancelled']), key=lambda o: o['zip'] or '99999'):
        a = o['address'] or {}
        items = ' · '.join('%s ×%s' % (names.get(k, k), q) for k, q in o['items'].items() if q)
        w.writerow(['@' + norm_u(o['user']), a.get('name', ''), a.get('phone', ''), a.get('address', ''),
                    o['zip'] or a.get('postal', ''), a.get('maps', ''), items, o['food'], o['fee'], o['total'],
                    'ใช่' if o['paid'] else '', o['note'] or ''])
    return '﻿' + buf.getvalue()   # BOM so Excel opens Thai correctly


# -------------------------------------------------------------------- http
class H(BaseHTTPRequestHandler):
    server_version = 'leeorders'

    def log_message(self, fmt, *a):
        pass

    def who(self):
        return {'user': self.headers.get('Remote-User', ''), 'name': self.headers.get('Remote-Name', ''),
                'groups': [g for g in self.headers.get('Remote-Groups', '').split(',') if g]}

    def send(self, code, body, ctype='application/json; charset=utf-8', extra=None):
        if not isinstance(body, (bytes, bytearray)):
            body = (json.dumps(body, ensure_ascii=False) if ctype.startswith('application/json') else body).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 64 * 1024:
            raise ValueError('too large')
        return json.loads(self.rfile.read(n) or b'{}')

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path in STATIC:
                fn, ct = STATIC[path]
                with open(os.path.join(HERE, fn), 'rb') as f:
                    return self.send(200, f.read(), ct)
            if path == '/api/me':
                return self.send(200, self.who())
            if path == '/api/rounds':
                return self.send(200, rounds_list())
            m = re.fullmatch(r'/api/round/([^/]+)/shipping\.csv', path)
            if m:
                if round_data(m.group(1)) is None:
                    return self.send(404, {'error': 'no such round'})
                return self.send(200, shipping_csv(m.group(1)), 'text/csv; charset=utf-8',
                                 {'Content-Disposition': 'attachment; filename="shipping-%s.csv"' % m.group(1)})
            m = re.fullmatch(r'/api/round/([^/]+)', path)
            if m:
                v = round_view(m.group(1))
                return self.send(200, v) if v else self.send(404, {'error': 'no such round'})
            if path == '/api/customers':
                return self.send(200, customers())
            m = re.fullmatch(r'/api/customer/([^/]+)', path)
            if m:
                return self.send(200, customer(urllib.parse.unquote(m.group(1))))
            if path == '/api/notes':
                with db() as c:
                    rows = [dict(r) for r in c.execute(
                        'SELECT * FROM notes WHERE round_id IS NULL OR done=0 ORDER BY id DESC LIMIT 300')]
                return self.send(200, rows)
            return self.send(404, {'error': 'not found'})
        except Exception as e:   # never leak a traceback to the page
            sys.stderr.write('GET %s failed: %r\n' % (path, e))
            return self.send(500, {'error': 'server error'})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        me = self.who()
        by = me['user'] or 'unknown'
        try:
            b = self.body()
            with LOCK, db() as c:
                if path == '/api/status':
                    rid, k = b.get('round'), b.get('key')
                    if round_data(rid) is None or not k:
                        return self.send(400, {'error': 'bad round/key'})
                    cur = c.execute('SELECT * FROM status WHERE round_id=? AND okey=?', (rid, k)).fetchone()
                    cur = dict(cur) if cur else {'paid': 0, 'shipped': 0, 'fee': None}
                    for f in ('paid', 'shipped'):
                        if f in b:
                            cur[f] = 1 if b[f] else 0
                    if 'fee' in b:
                        cur['fee'] = None if b['fee'] in (None, '') else max(0, int(b['fee']))
                    c.execute('INSERT OR REPLACE INTO status(round_id,okey,paid,shipped,fee,by,at) VALUES(?,?,?,?,?,?,?)',
                              (rid, k, cur['paid'], cur['shipped'], cur['fee'], by, int(time.time())))
                    log_event(c, by, 'status', rid, k, payload={x: b[x] for x in ('paid', 'shipped', 'fee') if x in b})
                    return self.send(200, {'ok': True})
                if path == '/api/answer':
                    rid, qid, a = b.get('round'), b.get('qid'), str(b.get('answer', '')).strip()[:2000]
                    v = round_data(rid)
                    q = next((q for q in questions(v or {}) if q['id'] == qid), None)
                    if not q:
                        return self.send(400, {'error': 'bad question'})
                    c.execute('INSERT OR REPLACE INTO answers(round_id,qid,question,answer,by,at) VALUES(?,?,?,?,?,?)',
                              (rid, qid, q['text'], a, by, int(time.time())))
                    log_event(c, by, 'answer', rid, None, qid, {'question': q['text'], 'answer': a})
                    return self.send(200, {'ok': True})
                if path == '/api/note':
                    text = str(b.get('text', '')).strip()[:4000]
                    if not text:
                        return self.send(400, {'error': 'empty'})
                    rid = b.get('round') or None
                    if rid and round_data(rid) is None:
                        return self.send(400, {'error': 'bad round'})
                    cur = c.execute('INSERT INTO notes(at,by,round_id,okey,text) VALUES(?,?,?,?,?)',
                                    (int(time.time()), by, rid, b.get('key') or None, text))
                    log_event(c, by, 'note', rid, b.get('key'), str(cur.lastrowid), {'text': text})
                    return self.send(200, {'ok': True, 'id': cur.lastrowid})
                m = re.fullmatch(r'/api/note/(\d+)/done', path)
                if m:
                    if 'admins' not in me['groups']:
                        return self.send(403, {'error': 'admins only'})
                    reply = str(b.get('reply', '')).strip()[:4000] or None
                    c.execute('UPDATE notes SET done=1, done_by=?, done_at=?, reply=? WHERE id=?',
                              (by, int(time.time()), reply, int(m.group(1))))
                    log_event(c, by, 'note_done', None, None, m.group(1), {'reply': reply})
                    return self.send(200, {'ok': True})
            return self.send(404, {'error': 'not found'})
        except Exception as e:
            sys.stderr.write('POST %s failed: %r\n' % (path, e))
            return self.send(400, {'error': 'bad request'})


def inbox(since):
    sys.stdout.reconfigure(encoding='utf-8')
    with db() as c:
        ev = [dict(r) for r in c.execute('SELECT * FROM events WHERE at>? ORDER BY id', (since,))]
        open_notes = [dict(r) for r in c.execute('SELECT * FROM notes WHERE done=0 ORDER BY id')]
    for e in ev:
        e['payload'] = json.loads(e['payload']) if e['payload'] else None
    print(json.dumps({'now': int(time.time()), 'events': ev, 'openNotes': open_notes}, ensure_ascii=False))


if __name__ == '__main__':
    init_db()
    if len(sys.argv) > 1 and sys.argv[1] == 'inbox':
        inbox(int(sys.argv[2]) if len(sys.argv) > 2 else 0)
        sys.exit(0)
    port = int(os.environ.get('PORT', '8080'))
    print('leeorders on :%d, data %s' % (port, DATA), flush=True)
    ThreadingHTTPServer(('0.0.0.0', port), H).serve_forever()

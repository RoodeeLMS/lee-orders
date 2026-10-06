"""ครัวคุณหลี Orders - the AI-board version of the lee-orders site (stdlib only).

Read side:  the same round JSON the GitHub Pages site encrypts, synced in plaintext into
            /data/sync by _local/scripts/board_sync.py (index.json, orders/<id>.json,
            address-book.json). This app never parses Instagram; it only shows and annotates.
Write side: SQLite /data/lee.db - things only Khun Lee can supply:
            * answers to the open questions on a round (structured `questions` + every ⚠️ note)
            * per-order status: paid / shipped / shipping-fee override
            * free-text notes and instructions (general, per round, or per order),
              which Nick marks done with a reply
            * payment slips (images in /data/slips); attaching one ticks the order paid
            * round status set from the app (open / closed / delivered / cancelled), which
              overrides the synced status until the round def is updated to match
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
  POST /api/slip?round=&key=     raw image body (jpeg/png/webp/heic, <= 8 MB); ticks paid
  GET  /api/slip/<id>            the image
  POST /api/slip/<id>/delete     uploader or admins
  POST /api/round-status {round, status}
  GET  /api/round/<id>/history   every event on the round, newest first
  GET  /api/system               when the system last read comments / synced / read Lee's replies
  GET  /api/analytics?range=all|90|365   sales, dishes, customers, areas, weekdays
CLI (run by Claude through Portainer exec; everything it writes is attributed to SYSTEM_USER)
  python server.py inbox [since_epoch] [--mark]   JSON of events + open notes; --mark logs inbox_read
  python server.py log <kind> <round|-> [json] [--at epoch]   e.g. kind scan / sync
  python server.py note-done <id> [reply]
"""
import csv, datetime, hashlib, io, json, os, re, sqlite3, sys, threading, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA = os.environ.get('LEE_DATA', '/data')
SYNC = os.path.join(DATA, 'sync')
DB = os.path.join(DATA, 'lee.db')
SLIPS = os.path.join(DATA, 'slips')
SLIP_MAX = 8 * 1024 * 1024
ROUND_STATUSES = ('open', 'closed', 'delivered', 'cancelled')
SYSTEM_USER = 'claude'   # no Authelia account has this name, so the web side can never act as it

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
    os.makedirs(SLIPS, exist_ok=True)
    with db() as c:
        c.executescript('''
        CREATE TABLE IF NOT EXISTS status(round_id TEXT, okey TEXT, paid INT DEFAULT 0, shipped INT DEFAULT 0,
            fee INT, by TEXT, at INT, PRIMARY KEY(round_id, okey));
        CREATE TABLE IF NOT EXISTS answers(round_id TEXT, qid TEXT, question TEXT, answer TEXT, by TEXT, at INT,
            PRIMARY KEY(round_id, qid));
        CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, at INT, by TEXT, round_id TEXT, okey TEXT,
            text TEXT, done INT DEFAULT 0, done_by TEXT, done_at INT, reply TEXT);
        CREATE TABLE IF NOT EXISTS slips(id INTEGER PRIMARY KEY, round_id TEXT, okey TEXT, file TEXT, sha TEXT,
            size INT, by TEXT, at INT);
        CREATE TABLE IF NOT EXISTS round_state(round_id TEXT PRIMARY KEY, status TEXT, by TEXT, at INT);
        CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, at INT, by TEXT, kind TEXT, round_id TEXT,
            okey TEXT, ref TEXT, payload TEXT);
        ''')


def log_event(c, by, kind, round_id=None, okey=None, ref=None, payload=None):
    c.execute('INSERT INTO events(at,by,kind,round_id,okey,ref,payload) VALUES(?,?,?,?,?,?,?)',
              (int(time.time()), by, kind, round_id, okey, ref,
               json.dumps(payload, ensure_ascii=False) if payload is not None else None))


def image_ext(b):
    if b[:3] == b'\xff\xd8\xff':
        return 'jpg', 'image/jpeg'
    if b[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png', 'image/png'
    if b[:4] == b'RIFF' and b[8:12] == b'WEBP':
        return 'webp', 'image/webp'
    if b[4:8] == b'ftyp' and b[8:12] in (b'heic', b'heix', b'mif1', b'msf1', b'hevc'):
        return 'heic', 'image/heic'
    return None, None


def round_status(c, rid, synced):
    r = c.execute('SELECT * FROM round_state WHERE round_id=?', (rid,)).fetchone()
    return (r['status'], dict(r)) if r else (synced, None)


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
    if 'รับเอง' in (o.get('note') or ''):     # มารับเอง / ไปรับเอง / รับเอง: pickup, no delivery fee
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
        slips = {}
        for r in c.execute('SELECT id, okey, by, at FROM slips WHERE round_id=? ORDER BY id', (rid,)):
            slips.setdefault(r['okey'], []).append({'id': r['id'], 'by': r['by'], 'at': r['at']})
        status, override = round_status(c, rid, d.get('status'))
        acts = {}   # okey -> {'paid': (by, at, via), 'shipped': ..., 'fee': ...}: the LAST change of each
        for e in c.execute("SELECT by, at, kind, okey, payload FROM events WHERE round_id=? AND kind IN ('status','slip') ORDER BY id", (rid,)):
            pl = json.loads(e['payload']) if e['payload'] else {}
            a = acts.setdefault(e['okey'], {})
            if e['kind'] == 'slip':
                a['paid'] = (e['by'], e['at'], 'slip')
            for f in ('paid', 'shipped', 'fee'):
                if f in pl:
                    a[f] = (e['by'], e['at'], None)
        last_scan = c.execute("SELECT by, at, payload FROM events WHERE round_id=? AND kind='scan' ORDER BY id DESC LIMIT 1", (rid,)).fetchone()
        last_scan = dict(last_scan, payload=json.loads(last_scan['payload'] or 'null')) if last_scan else None
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
                'slips': slips.get(k, []),
                'acts': {f: {'by': v[0], 'at': v[1], 'via': v[2]} for f, v in acts.get(k, {}).items()},
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
        'id': rid, 'title': d.get('title'), 'status': status, 'syncedStatus': d.get('status'),
        'statusSetBy': override, 'lastScan': last_scan,
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
        'slips': sum(1 for o in act if o['slips']),
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
        out.append({'id': r['id'], 'title': r.get('title'), 'status': v['status'],
                    'deliveryDateLabel': r.get('deliveryDateLabel'), 'summary': v['summary'],
                    'lastScan': v['lastScan']})
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


VENDOR = 'lee_ancharlee'   # her own comments log DM customers' orders: one handle, many people
TH = datetime.timezone(datetime.timedelta(hours=7))   # the board runs in UTC; days are Bangkok days
WD_SHORT = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.']
TH_MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
WEEKDAYS = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์']


def be_date(s):
    """'2569-10-08' (Buddhist era) -> datetime.date(2026, 10, 8)."""
    try:
        y, m, d = (int(x) for x in str(s)[:10].split('-'))
        return datetime.date(y - 543 if y > 2400 else y, m, d)
    except ValueError:
        return None


def iso_ts(s):
    try:
        return datetime.datetime.fromisoformat(str(s).replace('Z', '+00:00')).timestamp()
    except ValueError:
        return None


def fill_stats(d):
    """How fast a round filled: minutes from the IG post to each order comment (vendor-logged
    DM orders excluded - they carry the time Lee typed them, not when the customer ordered)."""
    posted = iso_ts(d.get('postedAt')) if d.get('postedAt') else None
    if not posted:
        return None
    mins = sorted((iso_ts(o['time']) - posted) / 60 for o in d.get('orders', [])
                  if o.get('time') and not o.get('cancelled') and norm_u(o['user']) != VENDOR and iso_ts(o['time']))
    mins = [m for m in mins if m >= 0]
    if len(mins) < 5:
        return None
    n = len(mins)
    return {'posted': posted, 'n': n, 'h50': round(mins[(n - 1) // 2] / 60, 1), 'h90': round(mins[int((n - 1) * 0.9)] / 60, 1),
            'in1h': round(100 * sum(1 for m in mins if m <= 60) / n), 'in24h': round(100 * sum(1 for m in mins if m <= 1440) / n),
            'times': [posted + m * 60 for m in mins]}


def analytics(rng):
    today = datetime.datetime.now(TH).date()
    since = today - datetime.timedelta(days=int(rng)) if str(rng).isdigit() else None
    rounds, months, dishes, cust, zones, zips, wk = [], {}, {}, {}, {}, {}, {}
    by_hour = [0] * 24            # order comments by Bangkok hour of day
    post_slots = {}               # posting hour bucket -> rounds/orders
    fills = []
    seen = set()
    entries = []
    first_paid, tracked = {}, set()
    with db() as c:
        for e in c.execute("SELECT round_id, okey, at, kind, payload FROM events WHERE kind IN ('status','slip') ORDER BY id"):
            tracked.add(e['round_id'])
            pl = json.loads(e['payload']) if e['payload'] else {}
            if e['kind'] == 'slip' or pl.get('paid'):
                first_paid.setdefault((e['round_id'], e['okey']), e['at'])
    allc = {}           # every customer over ALL rounds (lapsed regulars ignore the range filter)
    delays = []         # days between delivery day and the first paid tick/slip (negative = paid before)
    unpaid_after = []   # delivered (or shipped) but not paid, in tracked rounds
    for r in index().get('orders', []):
        d = round_data(r['id'])
        if d:
            entries.append((be_date(d.get('deliveryDate') or r['id']), r, d))
    entries.sort(key=lambda x: (x[0] or datetime.date.min, x[1]['id']))
    for day, r, d in entries:
        v = round_view(r['id'])
        if v['status'] == 'cancelled':
            continue
        act = [o for o in v['orders'] if not o['cancelled']]
        names = {m['code']: m.get('short') or m.get('name') for m in d.get('menu', [])}
        pr = prices(d)
        new = 0
        handles = set()
        for o in act:
            h = norm_u(o['user'])
            handles.add(h)
            g = allc.setdefault(h, {'handle': h, 'rounds': set(), 'food': 0, 'last': None, 'lastLabel': ''})
            g['rounds'].add(r['id']); g['food'] += o['food']
            if day and (g['last'] is None or day >= g['last']):
                g['last'], g['lastLabel'] = day, (r.get('deliveryDateLabel') or '').split(' → ')[0]
            if r['id'] in tracked:
                pa = first_paid.get((r['id'], o['key']))
                if pa and day:
                    delays.append((datetime.datetime.fromtimestamp(pa, TH).date() - day).days)
                if not o['paid'] and (v['status'] == 'delivered' or o['shipped']):
                    unpaid_after.append({'handle': h, 'round': r['id'], 'label': (r.get('deliveryDateLabel') or '').split(' → ')[0],
                                         'total': o['total'], 'shipped': o['shipped']})
            if h not in seen:
                new += 1 if h != VENDOR else 0
        in_range = not since or (day and day >= since)
        seen |= handles
        if not in_range:
            continue
        food, fees = sum(o['food'] for o in act), sum(o['fee'] for o in act)
        fs = fill_stats(d)
        if fs:
            for t in fs.pop('times'):
                by_hour[datetime.datetime.fromtimestamp(t, TH).hour] += 1
            pt = datetime.datetime.fromtimestamp(fs['posted'], TH)
            slot = '%02d:00–%02d:59' % (pt.hour // 3 * 3, pt.hour // 3 * 3 + 2)
            ps = post_slots.setdefault(slot, {'slot': slot, 'rounds': 0, 'orders': 0, 'food': 0})
            ps['rounds'] += 1; ps['orders'] += len(act); ps['food'] += food
            fs['postedLabel'] = '%s %d %s %02d:%02d' % (WD_SHORT[pt.weekday()], pt.day, TH_MON[pt.month - 1], pt.hour, pt.minute)
            fs['postedWeekday'] = WEEKDAYS[pt.weekday()]
            fs['leadDays'] = (day - pt.date()).days if day else None
            fills.append(fs['h50'])
        rounds.append({'fill': fs,'id': r['id'], 'label': (r.get('deliveryDateLabel') or '').split(' → ')[0],
                       'date': day.isoformat() if day else None, 'status': v['status'],
                       'orders': len(act), 'food': food, 'fees': fees, 'customers': len(handles - {VENDOR}),
                       'new': new, 'paidAmt': v['summary']['paidAmt'], 'dueAmt': v['summary']['dueAmt'],
                       'title': d.get('title', '')})
        mk = day.strftime('%Y-%m') if day else '?'
        m = months.setdefault(mk, {'month': mk, 'rounds': 0, 'orders': 0, 'food': 0})
        m['rounds'] += 1; m['orders'] += len(act); m['food'] += food
        if day:
            w = wk.setdefault(day.weekday(), {'day': WEEKDAYS[day.weekday()], 'idx': day.weekday(), 'rounds': 0, 'orders': 0, 'food': 0})
            w['rounds'] += 1; w['orders'] += len(act); w['food'] += food
        for o in act:
            for k, q in o['items'].items():
                if not q:
                    continue
                n = names.get(k, k)
                x = dishes.setdefault(n, {'name': n, 'qty': 0, 'food': 0, 'rounds': set()})
                x['qty'] += q; x['food'] += q * pr.get(k, 0); x['rounds'].add(r['id'])
            h = norm_u(o['user'])
            c = cust.setdefault(h, {'handle': h, 'orders': 0, 'food': 0, 'rounds': set()})
            c['orders'] += 1; c['food'] += o['food']; c['rounds'].add(r['id'])
            z = o['zone'] if o['zone'] in ('กทม./ปริมณฑล', 'ต่างจังหวัด', 'มารับเอง') else 'ไม่ระบุ ปณ.'
            zones[z] = zones.get(z, 0) + 1
            if o['zip']:
                zips[o['zip']] = zips.get(o['zip'], 0) + 1
    people = [c for c in cust.values() if c['handle'] != VENDOR]
    buckets = {'1 รอบ': 0, '2–3 รอบ': 0, '4–9 รอบ': 0, '10+ รอบ': 0}
    for c in people:
        n = len(c['rounds'])
        buckets['1 รอบ' if n == 1 else '2–3 รอบ' if n <= 3 else '4–9 รอบ' if n <= 9 else '10+ รอบ'] += 1
    for x in list(dishes.values()) + list(cust.values()):
        x['rounds'] = len(x['rounds'])
    lapsed = [dict(g, rounds=len(g['rounds']), last=g['last'].isoformat(), days=(today - g['last']).days)
              for g in allc.values() if g['handle'] != VENDOR and g['last'] and len(g['rounds']) >= 3
              and (today - g['last']).days >= 30]
    delays.sort()
    pay = {'tracked': len(tracked), 'paid': len(delays),
           'median': delays[len(delays) // 2] if delays else None,
           'beforeDelivery': sum(1 for x in delays if x <= 0),
           'unpaidAfter': sorted(unpaid_after, key=lambda u: -u['total']),
           'unpaidAfterAmt': sum(u['total'] for u in unpaid_after)}
    tot_food = sum(r['food'] for r in rounds)
    tot_orders = sum(r['orders'] for r in rounds)
    return {
        'range': rng, 'since': since.isoformat() if since else None,
        'totals': {'rounds': len(rounds), 'orders': tot_orders, 'food': tot_food,
                   'fees': sum(r['fees'] for r in rounds), 'customers': len(people),
                   'repeat': sum(1 for c in people if c['rounds'] > 1),
                   'avgOrder': round(tot_food / tot_orders) if tot_orders else 0,
                   'avgRound': round(tot_food / len(rounds)) if rounds else 0},
        'rounds': rounds, 'months': sorted(months.values(), key=lambda m: m['month']),
        'weekdays': sorted(wk.values(), key=lambda w: w['idx']),
        'dishes': sorted(dishes.values(), key=lambda x: -x['food'])[:20],
        'topCustomers': sorted(people, key=lambda c: -c['food'])[:15],
        'vendor': cust.get(VENDOR),
        'loyalty': [{'label': k, 'n': v} for k, v in buckets.items()],
        'zones': sorted(({'zone': k, 'n': v} for k, v in zones.items()), key=lambda z: -z['n']),
        'zips': sorted(({'zip': k, 'n': v} for k, v in zips.items()), key=lambda z: -z['n'])[:12],
        'lapsed': sorted(lapsed, key=lambda g: (-g['rounds'], g['days']))[:25],
        'timing': {'rounds': len(fills), 'medianH50': sorted(fills)[(len(fills) - 1) // 2] if fills else None,
                   'byHour': by_hour,
                   'postSlots': sorted(post_slots.values(), key=lambda x: x['slot'])},
        'payments': pay,
    }


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
            m = re.fullmatch(r'/api/round/([^/]+)/history', path)
            if m:
                if round_data(m.group(1)) is None:
                    return self.send(404, {'error': 'no such round'})
                with db() as c:
                    rows = [dict(r) for r in c.execute(
                        'SELECT * FROM events WHERE round_id=? ORDER BY id DESC LIMIT 1000', (m.group(1),))]
                for r in rows:
                    r['payload'] = json.loads(r['payload']) if r['payload'] else None
                return self.send(200, rows)
            if path == '/api/analytics':
                rng = (urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get('range') or ['all'])[0]
                return self.send(200, analytics(rng if rng in ('all', '90', '365', '30') else 'all'))
            if path == '/api/system':
                return self.send(200, system_info())
            m = re.fullmatch(r'/api/round/([^/]+)', path)
            if m:
                v = round_view(m.group(1))
                return self.send(200, v) if v else self.send(404, {'error': 'no such round'})
            m = re.fullmatch(r'/api/slip/(\d+)', path)
            if m:
                with db() as c:
                    r = c.execute('SELECT file FROM slips WHERE id=?', (int(m.group(1)),)).fetchone()
                if not r:
                    return self.send(404, {'error': 'no such slip'})
                with open(os.path.join(SLIPS, r['file']), 'rb') as f:
                    b = f.read()
                return self.send(200, b, image_ext(b)[1] or 'application/octet-stream')
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
        if path == '/api/slip':
            try:
                return self.upload_slip(by)
            except Exception as e:
                sys.stderr.write('slip upload failed: %r\n' % e)
                return self.send(400, {'error': 'bad request'})
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
                if path == '/api/round-status':
                    rid, status = b.get('round'), b.get('status')
                    d = round_data(rid)
                    if d is None or status not in ROUND_STATUSES:
                        return self.send(400, {'error': 'bad round/status'})
                    prev = round_status(c, rid, d.get('status'))[0]
                    c.execute('INSERT OR REPLACE INTO round_state(round_id,status,by,at) VALUES(?,?,?,?)',
                              (rid, status, by, int(time.time())))
                    log_event(c, by, 'round_status', rid, None, None, {'from': prev, 'to': status})
                    return self.send(200, {'ok': True})
                m = re.fullmatch(r'/api/slip/(\d+)/delete', path)
                if m:
                    r = c.execute('SELECT * FROM slips WHERE id=?', (int(m.group(1)),)).fetchone()
                    if not r:
                        return self.send(404, {'error': 'no such slip'})
                    if r['by'] != by and 'admins' not in me['groups']:
                        return self.send(403, {'error': 'only the uploader can remove it'})
                    c.execute('DELETE FROM slips WHERE id=?', (r['id'],))
                    if not c.execute('SELECT 1 FROM slips WHERE file=?', (r['file'],)).fetchone():
                        try:
                            os.remove(os.path.join(SLIPS, r['file']))
                        except OSError:
                            pass
                    log_event(c, by, 'slip_removed', r['round_id'], r['okey'], str(r['id']))
                    return self.send(200, {'ok': True})
                m = re.fullmatch(r'/api/note/(\d+)/done', path)
                if m:
                    if 'admins' not in me['groups']:
                        return self.send(403, {'error': 'admins only'})
                    reply = str(b.get('reply', '')).strip()[:4000] or None
                    if not note_done(c, int(m.group(1)), by, reply):
                        return self.send(404, {'error': 'no such note'})
                    return self.send(200, {'ok': True})
            return self.send(404, {'error': 'not found'})
        except Exception as e:
            sys.stderr.write('POST %s failed: %r\n' % (path, e))
            return self.send(400, {'error': 'bad request'})


    def upload_slip(self, by):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        rid, k = (q.get('round') or [''])[0], (q.get('key') or [''])[0]
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > SLIP_MAX:
            return self.send(413 if n else 400, {'error': 'ไฟล์ใหญ่เกินไป' if n else 'ไม่มีไฟล์'})
        blob = self.rfile.read(n)
        v = round_view(rid) if round_data(rid) is not None else None
        if not v or not any(o['key'] == k for o in v['orders']):
            return self.send(400, {'error': 'bad round/key'})
        ext, _ = image_ext(blob)
        if not ext:
            return self.send(415, {'error': 'ไม่ใช่ไฟล์รูป'})
        sha = hashlib.sha256(blob).hexdigest()
        with LOCK, db() as c:
            dup = c.execute('SELECT round_id, okey FROM slips WHERE sha=?', (sha,)).fetchone()
            if dup:
                return self.send(409, {'error': 'สลิปนี้แนบไว้แล้วกับ @%s (รอบ %s)' % (
                    norm_u(dup['okey'].replace('cap:', '')), dup['round_id'][:10])})
            fn = '%s.%s' % (sha[:32], ext)
            with open(os.path.join(SLIPS, fn), 'wb') as f:
                f.write(blob)
            cur = c.execute('INSERT INTO slips(round_id,okey,file,sha,size,by,at) VALUES(?,?,?,?,?,?,?)',
                            (rid, k, fn, sha, n, by, int(time.time())))
            st = c.execute('SELECT * FROM status WHERE round_id=? AND okey=?', (rid, k)).fetchone()
            st = dict(st) if st else {'shipped': 0, 'fee': None}
            c.execute('INSERT OR REPLACE INTO status(round_id,okey,paid,shipped,fee,by,at) VALUES(?,?,?,?,?,?,?)',
                      (rid, k, 1, st['shipped'], st['fee'], by, int(time.time())))
            log_event(c, by, 'slip', rid, k, str(cur.lastrowid), {'bytes': n})
        return self.send(200, {'ok': True, 'id': cur.lastrowid})


def note_done(c, nid, by, reply):
    n = c.execute('SELECT * FROM notes WHERE id=?', (nid,)).fetchone()
    if not n:
        return False
    c.execute('UPDATE notes SET done=1, done_by=?, done_at=?, reply=? WHERE id=?', (by, int(time.time()), reply, nid))
    log_event(c, by, 'note_done', n['round_id'], n['okey'], str(nid), {'reply': reply, 'text': n['text'][:200]})
    return True


def system_info():
    with db() as c:
        def last(kind, where='', args=()):
            r = c.execute('SELECT by, at, round_id, payload FROM events WHERE kind=? %s ORDER BY id DESC LIMIT 1' % where,
                          (kind,) + args).fetchone()
            return dict(r, payload=json.loads(r['payload'] or 'null')) if r else None
        return {'lastUpdateRounds': last('sync', "AND payload LIKE '%update rounds%'"),
                'lastSync': last('sync'), 'lastScan': last('scan'), 'lastInboxRead': last('inbox_read')}


def inbox(since, mark=False):
    sys.stdout.reconfigure(encoding='utf-8')
    with db() as c:
        if mark:
            log_event(c, SYSTEM_USER, 'inbox_read')
        ev = [dict(r) for r in c.execute('SELECT * FROM events WHERE at>? ORDER BY id', (since,))]
        open_notes = [dict(r) for r in c.execute('SELECT * FROM notes WHERE done=0 ORDER BY id')]
    for e in ev:
        e['payload'] = json.loads(e['payload']) if e['payload'] else None
    print(json.dumps({'now': int(time.time()), 'events': ev, 'openNotes': open_notes}, ensure_ascii=False))


if __name__ == '__main__':
    init_db()
    argv = [a for a in sys.argv[1:] if a != '--mark']
    if argv and argv[0] == 'inbox':
        inbox(int(argv[1]) if len(argv) > 1 else 0, '--mark' in sys.argv)
        sys.exit(0)
    if argv and argv[0] == 'log':          # log <kind> <round|-> [json] [--at epoch]
        at = None
        if '--at' in argv:
            i = argv.index('--at')
            at = int(argv[i + 1])
            del argv[i:i + 2]
        with db() as c:
            log_event(c, SYSTEM_USER, argv[1], None if argv[2] == '-' else argv[2], None, None,
                      json.loads(argv[3]) if len(argv) > 3 else None)
            if at:
                c.execute('UPDATE events SET at=? WHERE id=(SELECT MAX(id) FROM events)', (at,))
        print('logged')
        sys.exit(0)
    if argv and argv[0] == 'note-done':    # note-done <id> [reply]
        with db() as c:
            ok = note_done(c, int(argv[1]), SYSTEM_USER, argv[2] if len(argv) > 2 else None)
        print('done' if ok else 'no such note')
        sys.exit(0)
    port = int(os.environ.get('PORT', '8080'))
    print('leeorders on :%d, data %s' % (port, DATA), flush=True)
    ThreadingHTTPServer(('0.0.0.0', port), H).serve_forever()

from flask import Flask, render_template, request, jsonify, send_file, session, redirect, url_for
import sqlite3, os, uuid, csv, io, hashlib, secrets, functools
from datetime import datetime, date, timedelta
import calendar

TURSO_URL   = os.environ.get('TURSO_URL', '')
TURSO_TOKEN = os.environ.get('TURSO_TOKEN', '')

app = Flask(__name__)
app.secret_key = 'lap-terapevtska-skupina-2026-static-key'
DB_PATH = os.environ.get('DB_PATH', os.path.join(os.path.dirname(__file__), 'terapevtska.db'))
DAYS_SL = ['Ponedeljek','Torek','Sreda','Četrtek','Petek','Sobota','Nedelja']

# ── Turso wrapper — makes libsql_experimental behave like sqlite3 ─────────────
if TURSO_URL:
    import libsql_experimental as _libsql

    class _Row:
        def __init__(self, description, data):
            self._cols = [d[0] for d in description]
            self._data = tuple(data)
        def __getitem__(self, key):
            if isinstance(key, str):
                return self._data[self._cols.index(key)]
            return self._data[key]
        def __iter__(self):
            return iter(self._data)
        def keys(self):
            return self._cols
        def __len__(self):
            return len(self._data)

    class _Cursor:
        def __init__(self, cur):
            self._cur = cur
        def execute(self, sql, params=None):
            self._cur.execute(sql, params) if params is not None else self._cur.execute(sql)
            return self
        def executemany(self, sql, seq):
            for p in seq: self._cur.execute(sql, p)
            return self
        def fetchone(self):
            row = self._cur.fetchone()
            if row is None: return None
            return _Row(self._cur.description, row) if self._cur.description else row
        def fetchall(self):
            rows = self._cur.fetchall()
            desc = self._cur.description
            return [_Row(desc, r) for r in rows] if desc else rows
        @property
        def description(self):
            return self._cur.description

    class _Conn:
        def __init__(self, conn):
            self._conn = conn
        def cursor(self):
            return _Cursor(self._conn.cursor())
        def execute(self, sql, params=None):
            c = self._conn.cursor()
            c.execute(sql, params) if params is not None else c.execute(sql)
            return _Cursor(c)
        def executemany(self, sql, seq):
            for p in seq: self._conn.cursor().execute(sql, p)
        def commit(self):
            self._conn.commit()
        def close(self):
            self._conn.close()

# ── DB helpers ────────────────────────────────────────────────────────────────
def get_db():
    if TURSO_URL:
        conn = _libsql.connect(database=TURSO_URL, auth_token=TURSO_TOKEN)
        conn.execute("PRAGMA foreign_keys = ON")
        return _Conn(conn)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def hash_password(password, salt=None):
    if salt is None: salt = secrets.token_hex(16)
    return hashlib.sha256((salt + password).encode()).hexdigest(), salt

def login_required(f):
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            if request.path.startswith('/api/'): return jsonify({'error':'Unauthorized'}), 401
            return redirect(url_for('login_page'))
        return f(*args, **kwargs)
    return decorated

def audit(conn, action, table, record_id, detail=''):
    conn.execute("INSERT INTO audit_log VALUES (?,?,?,?,?,?,?)",
        (str(uuid.uuid4()), datetime.now().isoformat(),
         session.get('user_id','?'), session.get('username','?'),
         action, table, f"{record_id} | {detail}" if detail else record_id))

def get_setting(conn, key, default=''):
    r = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return r['value'] if r else default

# ── Migration — NIKOLI VEČ NE BRIŠI BAZE ─────────────────────────────────────
def migrate_db(conn):
    """Doda manjkajoče stolpce/tabele v obstoječo bazo. Varno za zagon večkrat."""
    c = conn.cursor()
    # Pridobi obstoječe stolpce za vsako tabelo
    def cols(tbl):
        try: return {r[1] for r in c.execute(f"PRAGMA table_info({tbl})").fetchall()}
        except: return set()

    # Tabela: member_pricing — mesečne cene glede na obisk/teden
    c.execute("""CREATE TABLE IF NOT EXISTS member_pricing (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        visits_per_week INTEGER NOT NULL DEFAULT 1,
        monthly_price REAL NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (member_id) REFERENCES members(id),
        FOREIGN KEY (group_id) REFERENCES groups(id)
    )""")

    # Tabela: member_discount — individualni popust na člana
    c.execute("""CREATE TABLE IF NOT EXISTS member_discount (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL UNIQUE,
        discount_type TEXT NOT NULL DEFAULT 'percent',
        discount_value REAL NOT NULL,
        reason TEXT,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (member_id) REFERENCES members(id)
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        session_date TEXT NOT NULL,
        notes TEXT,
        cancelled INTEGER NOT NULL DEFAULT 0,
        cancel_reason TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (group_id) REFERENCES groups(id)
    )""")

    # Dodaj manjkajoče stolpce v obstoječe tabele
    existing_groups = cols('groups')
    if 'sessions_per_week' not in existing_groups:
        c.execute("ALTER TABLE groups ADD COLUMN sessions_per_week INTEGER NOT NULL DEFAULT 1")
    if 'base_monthly_price' not in existing_groups:
        c.execute("ALTER TABLE groups ADD COLUMN base_monthly_price REAL")
    if 'max_members' not in existing_groups:
        c.execute("ALTER TABLE groups ADD COLUMN max_members INTEGER NOT NULL DEFAULT 12")

    existing_members = cols('members')
    for col, typedef in [
        ('address', 'TEXT'), ('date_of_birth', 'TEXT'),
        ('emergency_contact', 'TEXT'), ('emergency_phone', 'TEXT'),
        ('notes', 'TEXT'), ('created_by', 'TEXT'),
        ('updated_by', 'TEXT'), ('updated_at', 'TEXT'),
    ]:
        if col not in existing_members:
            c.execute(f"ALTER TABLE members ADD COLUMN {col} {typedef}")

    existing_att = cols('attendance')
    for col, typedef in [('recorded_by','TEXT'),('recorded_at','TEXT')]:
        if col not in existing_att:
            c.execute(f"ALTER TABLE attendance ADD COLUMN {col} {typedef}")

    existing_groups_cols = cols('groups')
    for col, typedef in [('created_by','TEXT'),('updated_by','TEXT')]:
        if col not in existing_groups_cols:
            c.execute(f"ALTER TABLE groups ADD COLUMN {col} {typedef}")

    # Ustvari manjkajoče tabele
    c.execute("""CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY, member_id TEXT NOT NULL, amount REAL NOT NULL,
        payment_date TEXT NOT NULL, method TEXT NOT NULL DEFAULT 'gotovina',
        period_year INTEGER NOT NULL, period_month INTEGER NOT NULL,
        notes TEXT, created_by TEXT, created_at TEXT NOT NULL,
        FOREIGN KEY (member_id) REFERENCES members(id)
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY, member_id TEXT NOT NULL, contact_date TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'klic', notes TEXT NOT NULL,
        followup_date TEXT, created_by TEXT, created_at TEXT NOT NULL,
        FOREIGN KEY (member_id) REFERENCES members(id)
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, user_id TEXT NOT NULL,
        username TEXT NOT NULL, action TEXT NOT NULL, table_name TEXT NOT NULL, detail TEXT
    )""")
    conn.commit()

def init_db():
    conn = get_db(); c = conn.cursor()
    # Ustvari osnovne tabele
    c.execute("""CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT,
        password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT,
        status TEXT NOT NULL DEFAULT 'active', enrollment_date TEXT NOT NULL
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, day_of_week INTEGER NOT NULL,
        time TEXT NOT NULL, fee_per_session REAL NOT NULL DEFAULT 30.0
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL, member_id TEXT NOT NULL,
        PRIMARY KEY (group_id, member_id),
        FOREIGN KEY (group_id) REFERENCES groups(id),
        FOREIGN KEY (member_id) REFERENCES members(id)
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS attendance (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, member_id TEXT NOT NULL,
        date TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('present','absent_excused','absent_unexcused','makeup')),
        makeup_for_date TEXT, makeup_group_id TEXT, absence_end_date TEXT, notes TEXT,
        FOREIGN KEY (group_id) REFERENCES groups(id),
        FOREIGN KEY (member_id) REFERENCES members(id)
    )""")
    conn.commit()
    # Zaženi migracije (doda nove stolpce/tabele)
    migrate_db(conn)
    # Default settings
    defaults = [('discount_percent','20'),('discount_days','7'),('currency','EUR'),('org_name','Lipovž Active Program')]
    for k, v in defaults:
        if not c.execute("SELECT key FROM settings WHERE key=?", (k,)).fetchone():
            c.execute("INSERT INTO settings VALUES (?,?)", (k, v))
    if not c.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
        pw_hash, pw_salt = hash_password('admin123')
        c.execute("INSERT INTO users VALUES (?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), 'admin', 'admin@lap.si', pw_hash, pw_salt, 'admin', date.today().isoformat()))
    if not c.execute("SELECT COUNT(*) FROM groups").fetchone()[0]:
        seed_data(c)
    conn.commit(); conn.close()

def seed_data(c):
    today = date.today()
    groups = [
        (str(uuid.uuid4()), 'Ponedeljek 08:00', 0, '08:00', 30.0, 1, None, 'system', None, 12),
        (str(uuid.uuid4()), 'Sreda 10:00', 2, '10:00', 30.0, 1, None, 'system', None, 12),
        (str(uuid.uuid4()), 'Petek 09:00', 4, '09:00', 30.0, 1, None, 'system', None, 12),
    ]
    c.executemany("INSERT INTO groups VALUES (?,?,?,?,?,?,?,?,?,?)", groups)
    members = [
        (str(uuid.uuid4()), 'Ana Novak', 'ana@example.com', '041 111 222', 'Ljubljana', '1985-03-12', 'Marko Novak', '040 999 111', '', 'active', '2026-01-10', 'system', None, None),
        (str(uuid.uuid4()), 'Janez Kranjc', None, '040 333 444', 'Maribor', '1978-07-24', None, None, '', 'active', '2026-01-15', 'system', None, None),
        (str(uuid.uuid4()), 'Maja Horvat', 'maja@example.com', None, 'Koper', '1992-11-05', 'Tina Horvat', '051 222 333', '', 'active', '2026-02-01', 'system', None, None),
        (str(uuid.uuid4()), 'Luka Kovač', None, '031 555 666', None, '1990-01-30', None, None, '', 'active', '2026-02-10', 'system', None, None),
        (str(uuid.uuid4()), 'Sara Žnidar', 'sara@example.com', '070 777 888', 'Celje', '1995-06-18', 'Petra Žnidar', '070 000 111', '', 'active', '2026-03-01', 'system', None, None),
    ]
    c.executemany("""INSERT INTO members
        (id,name,email,phone,address,date_of_birth,emergency_contact,emergency_phone,notes,status,enrollment_date,created_by,updated_by,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", members)
    g0,g1,g2 = groups[0][0],groups[1][0],groups[2][0]
    m0,m1,m2,m3,m4 = [m[0] for m in members]
    c.executemany("INSERT INTO group_members VALUES (?,?)", [(g0,m0),(g0,m1),(g0,m2),(g1,m1),(g1,m3),(g1,m4),(g2,m0),(g2,m2),(g2,m4)])
    now = datetime.now().isoformat()
    records = []
    for wo in range(3):
        mon = today - timedelta(days=today.weekday()) - timedelta(weeks=wo)
        wed, fri = mon+timedelta(2), mon+timedelta(4)
        if mon <= today:
            for mid in [m0,m1,m2]: records.append((str(uuid.uuid4()),g0,mid,mon.isoformat(),'present',None,None,None,None,'system',now))
        if wed <= today:
            for mid in [m1,m3,m4]:
                st = 'absent_excused' if (mid==m3 and wo==1) else 'present'
                records.append((str(uuid.uuid4()),g1,mid,wed.isoformat(),st,None,None,None,None,'system',now))
        if fri <= today:
            for mid in [m0,m2,m4]: records.append((str(uuid.uuid4()),g2,mid,fri.isoformat(),'present',None,None,None,None,'system',now))
    c.executemany("INSERT INTO attendance VALUES (?,?,?,?,?,?,?,?,?,?,?)", records)
    # Seed member pricing (1x/teden = 90€/mesec)
    for mid in [m0,m1,m2,m3,m4]:
        c.execute("INSERT INTO member_pricing VALUES (?,?,?,?,?,?,?,?,?)",
            (str(uuid.uuid4()), mid, g0, 1, 90.0, '2026-01-01', None, 'system', now))
    c.execute("INSERT INTO payments VALUES (?,?,?,?,?,?,?,?,?,?)",
        (str(uuid.uuid4()), m0, 90.0, today.replace(day=1).isoformat(), 'nakazilo',
         today.year, today.month, 'Plačilo za mesec', 'system', now))

# ── Pricing helpers ───────────────────────────────────────────────────────────
def get_member_price(conn, member_id, group_id, for_date):
    """Vrne mesečno ceno za člana v skupini na določen datum."""
    row = conn.execute("""
        SELECT monthly_price, visits_per_week FROM member_pricing
        WHERE member_id=? AND group_id=? AND valid_from<=?
        AND (valid_to IS NULL OR valid_to>=?)
        ORDER BY valid_from DESC LIMIT 1
    """, (member_id, group_id, for_date, for_date)).fetchone()
    if row: return row['monthly_price'], row['visits_per_week']
    # Fallback: fee_per_session * sessions v mesecu
    g = conn.execute("SELECT fee_per_session, sessions_per_week FROM groups WHERE id=?", (group_id,)).fetchone()
    if g:
        spw = g['sessions_per_week'] or 1
        return g['fee_per_session'] * spw * 4, spw
    return 120.0, 1

def count_sessions_in_month(year, month, day_of_week):
    """Šteje koliko določenih dni v tednu je v mesecu."""
    first = date(year, month, 1)
    last = date(year, month, calendar.monthrange(year, month)[1])
    count = 0
    cur = first
    while cur <= last:
        if cur.weekday() == day_of_week: count += 1
        cur += timedelta(1)
    return count

# ── Auth ──────────────────────────────────────────────────────────────────────
@app.route('/login')
def login_page():
    if 'user_id' in session: return redirect('/')
    return render_template('login.html')

@app.route('/api/auth/login', methods=['POST'])
def do_login():
    d = request.get_json(force=True, silent=True) or {}
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE username=?", (d.get('username',''),)).fetchone()
    if not user: conn.close(); return jsonify({'error':'Napačno uporabniško ime ali geslo.'}), 401
    pw_hash, _ = hash_password(d.get('password',''), user['password_salt'])
    if pw_hash != user['password_hash']: conn.close(); return jsonify({'error':'Napačno uporabniško ime ali geslo.'}), 401
    session.clear()
    session['user_id'] = user['id']; session['username'] = user['username']; session['role'] = user['role']
    conn.close()
    return jsonify({'ok':True,'username':user['username'],'role':user['role']})

@app.route('/api/auth/logout', methods=['POST'])
def do_logout(): session.clear(); return jsonify({'ok':True})

@app.route('/api/auth/register', methods=['POST'])
@login_required
def do_register():
    if session.get('role') != 'admin': return jsonify({'error':'Samo admin.'}), 403
    d = request.get_json(force=True, silent=True) or {}
    username = d.get('username','').strip()
    if len(username) < 3: return jsonify({'error':'Ime vsaj 3 znake.'}), 400
    if len(d.get('password','')) < 6: return jsonify({'error':'Geslo vsaj 6 znakov.'}), 400
    conn = get_db()
    if conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone():
        conn.close(); return jsonify({'error':'Ime že obstaja.'}), 400
    pw_hash, pw_salt = hash_password(d['password'])
    uid = str(uuid.uuid4())
    conn.execute("INSERT INTO users VALUES (?,?,?,?,?,?,?)",
        (uid, username, d.get('email',''), pw_hash, pw_salt, d.get('role','user'), date.today().isoformat()))
    audit(conn,'CREATE','users',uid,username)
    conn.commit(); conn.close(); return jsonify({'ok':True})

@app.route('/api/auth/change-password', methods=['POST'])
@login_required
def change_password():
    d = request.get_json(force=True, silent=True) or {}
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE id=?", (session['user_id'],)).fetchone()
    old_hash, _ = hash_password(d.get('old_password',''), user['password_salt'])
    if old_hash != user['password_hash']: conn.close(); return jsonify({'error':'Napačno trenutno geslo.'}), 400
    if len(d.get('new_password','')) < 6: conn.close(); return jsonify({'error':'Geslo vsaj 6 znakov.'}), 400
    new_hash, new_salt = hash_password(d['new_password'])
    conn.execute("UPDATE users SET password_hash=?, password_salt=? WHERE id=?", (new_hash, new_salt, session['user_id']))
    audit(conn,'CHANGE_PASSWORD','users',session['user_id'])
    conn.commit(); conn.close(); return jsonify({'ok':True})

@app.route('/api/auth/users')
@login_required
def list_users():
    if session.get('role') != 'admin': return jsonify({'error':'Nedostopno.'}), 403
    conn = get_db()
    users = [dict(r) for r in conn.execute("SELECT id,username,email,role,created_at FROM users ORDER BY created_at").fetchall()]
    conn.close(); return jsonify(users)

@app.route('/api/auth/users/<uid>', methods=['DELETE'])
@login_required
def delete_user(uid):
    if session.get('role') != 'admin': return jsonify({'error':'Nedostopno.'}), 403
    if uid == session['user_id']: return jsonify({'error':'Ne moreš izbrisati sebe.'}), 400
    conn = get_db(); audit(conn,'DELETE','users',uid)
    conn.execute("DELETE FROM users WHERE id=?", (uid,))
    conn.commit(); conn.close(); return jsonify({'ok':True})

@app.route('/api/auth/me')
@login_required
def get_me(): return jsonify({'username':session.get('username'),'role':session.get('role')})

# ── Settings ──────────────────────────────────────────────────────────────────
@app.route('/api/settings')
@login_required
def get_settings():
    conn = get_db()
    rows = {r['key']:r['value'] for r in conn.execute("SELECT * FROM settings").fetchall()}
    conn.close(); return jsonify(rows)

@app.route('/api/settings', methods=['POST'])
@login_required
def save_settings():
    if session.get('role') != 'admin': return jsonify({'error':'Samo admin.'}), 403
    d = request.get_json(force=True, silent=True) or {}
    conn = get_db()
    for k, v in d.items():
        conn.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (k, str(v)))
    audit(conn,'UPDATE','settings','settings',str(d))
    conn.commit(); conn.close(); return jsonify({'ok':True})

# ── Audit ─────────────────────────────────────────────────────────────────────
@app.route('/api/audit')
@login_required
def get_audit():
    if session.get('role') != 'admin': return jsonify({'error':'Nedostopno.'}), 403
    conn = get_db()
    rows = [dict(r) for r in conn.execute("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 300").fetchall()]
    conn.close(); return jsonify(rows)

# ── Main ──────────────────────────────────────────────────────────────────────
@app.route('/')
@login_required
def index():
    return render_template('index.html', username=session.get('username'), role=session.get('role'))

# ── Groups ────────────────────────────────────────────────────────────────────
@app.route('/api/groups')
@login_required
def get_groups():
    conn = get_db()
    groups = [dict(r) for r in conn.execute("SELECT * FROM groups ORDER BY day_of_week, time").fetchall()]
    for g in groups:
        g['member_count'] = conn.execute("SELECT COUNT(*) FROM group_members WHERE group_id=?", (g['id'],)).fetchone()[0]
        g['day_name'] = DAYS_SL[g['day_of_week']]
    conn.close(); return jsonify(groups)

@app.route('/api/groups', methods=['POST'])
@login_required
def create_group():
    d = request.get_json(force=True, silent=True) or {}
    gid = str(uuid.uuid4()); conn = get_db()
    conn.execute("""INSERT INTO groups (id,name,day_of_week,time,fee_per_session,sessions_per_week,
        base_monthly_price,created_by,updated_by,max_members) VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (gid, d['name'], int(d['day_of_week']), d['time'],
         float(d.get('fee_per_session',30.0)),
         int(d.get('sessions_per_week',1)),
         d.get('base_monthly_price') or None,
         session.get('username'), None,
         max(int(d.get('max_members',12)),1)))
    audit(conn,'CREATE','groups',gid,d['name'])
    conn.commit(); conn.close(); return jsonify({'id':gid})

@app.route('/api/groups/<gid>', methods=['PUT'])
@login_required
def update_group(gid):
    d = request.get_json(force=True, silent=True) or {}; conn = get_db()
    g_cur = conn.execute("SELECT * FROM groups WHERE id=?", (gid,)).fetchone()
    conn.execute("""UPDATE groups SET name=?,day_of_week=?,time=?,fee_per_session=?,
        sessions_per_week=?,base_monthly_price=?,updated_by=?,max_members=? WHERE id=?""",
        (d['name'],int(d['day_of_week']),d['time'],
         float(d.get('fee_per_session', g_cur['fee_per_session'] if g_cur else 30.0)),
         int(d.get('sessions_per_week', g_cur['sessions_per_week'] if g_cur else 1)),
         d.get('base_monthly_price') or None,
         session.get('username'),
         min(max(int(d.get('max_members', g_cur['max_members'] if g_cur else 12)),1),24),
         gid))
    audit(conn,'UPDATE','groups',gid,d['name'])
    conn.commit(); conn.close(); return jsonify({'ok':True})

@app.route('/api/groups/<gid>', methods=['DELETE'])
@login_required
def delete_group(gid):
    conn = get_db(); audit(conn,'DELETE','groups',gid)
    conn.execute("DELETE FROM group_members WHERE group_id=?", (gid,))
    conn.execute("DELETE FROM attendance WHERE group_id=?", (gid,))
    conn.execute("DELETE FROM sessions WHERE group_id=?", (gid,))
    conn.execute("DELETE FROM groups WHERE id=?", (gid,))
    conn.commit(); conn.close(); return jsonify({'ok':True})

# ── Sessions (termini) ────────────────────────────────────────────────────────
@app.route('/api/groups/<gid>/sessions')
@login_required
def get_group_sessions(gid):
    """Vrne termine za skupino — zadnjih 8 tednov + naslednjih 4 tedne."""
    conn = get_db()
    g = conn.execute("SELECT * FROM groups WHERE id=?", (gid,)).fetchone()
    if not g: conn.close(); return jsonify([])
    dow = g['day_of_week']
    today = date.today()
    start = today - timedelta(weeks=8)
    end = today + timedelta(weeks=4)
    # Generiraj vse termine v razponu
    sessions = []
    cur = start
    while cur <= end:
        if cur.weekday() == dow:
            session_rec = conn.execute(
                "SELECT * FROM sessions WHERE group_id=? AND session_date=?",
                (gid, cur.isoformat())).fetchone()
            att_count = conn.execute(
                "SELECT COUNT(*) FROM attendance WHERE group_id=? AND date=? AND status='present'",
                (gid, cur.isoformat())).fetchone()[0]
            att_total = conn.execute(
                "SELECT COUNT(*) FROM attendance WHERE group_id=? AND date=?",
                (gid, cur.isoformat())).fetchone()[0]
            sessions.append({
                'date': cur.isoformat(),
                'date_fmt': cur.strftime('%d.%m.%Y'),
                'weekday': DAYS_SL[cur.weekday()],
                'is_past': cur < today,
                'is_today': cur == today,
                'is_future': cur > today,
                'cancelled': session_rec['cancelled'] if session_rec else 0,
                'cancel_reason': session_rec['cancel_reason'] if session_rec else None,
                'notes': session_rec['notes'] if session_rec else None,
                'session_id': session_rec['id'] if session_rec else None,
                'attendance_present': att_count,
                'attendance_total': att_total,
                'has_attendance': att_total > 0,
            })
        cur += timedelta(1)
    conn.close()
    return jsonify(list(reversed(sessions)))  # najnovejši najprej

@app.route('/api/sessions', methods=['POST'])
@login_required
def upsert_session():
    """Ustvari ali posodobi termin (npr. odpoved, opomba)."""
    d = request.get_json(force=True, silent=True) or {}
    conn = get_db()
    now = datetime.now().isoformat()
    existing = conn.execute(
        "SELECT id FROM sessions WHERE group_id=? AND session_date=?",
        (d['group_id'], d['session_date'])).fetchone()
    if existing:
        conn.execute("""UPDATE sessions SET notes=?,cancelled=?,cancel_reason=? WHERE id=?""",
            (d.get('notes'), int(d.get('cancelled',0)), d.get('cancel_reason'), existing['id']))
        sid = existing['id']
    else:
        sid = str(uuid.uuid4())
        conn.execute("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)",
            (sid, d['group_id'], d['session_date'],
             d.get('notes'), int(d.get('cancelled',0)), d.get('cancel_reason'),
             session.get('username'), now))
    audit(conn,'UPSERT','sessions',sid,f"{d['group_id']} {d['session_date']}")
    conn.commit(); conn.close()
    return jsonify({'ok':True,'id':sid})

# ── Members ───────────────────────────────────────────────────────────────────
@app.route('/api/members')
@login_required
def get_members():
    conn = get_db()
    members = [dict(r) for r in conn.execute("SELECT * FROM members ORDER BY name").fetchall()]
    month_str = date.today().strftime('%Y-%m')
    for m in members:
        m['groups'] = [dict(r) for r in conn.execute(
            "SELECT g.* FROM groups g JOIN group_members gm ON g.id=gm.group_id WHERE gm.member_id=?", (m['id'],)).fetchall()]
        stats = conn.execute("""SELECT
            COUNT(*) FILTER (WHERE status IN ('present','makeup')) as attended,
            COUNT(*) FILTER (WHERE status='absent_excused') as excused,
            COUNT(*) FILTER (WHERE status='absent_unexcused') as unexcused
            FROM attendance WHERE member_id=? AND strftime('%Y-%m',date)=?""", (m['id'],month_str)).fetchone()
        m['month_attended'] = stats['attended']; m['month_excused'] = stats['excused']; m['month_unexcused'] = stats['unexcused']
        last = conn.execute("SELECT date,status FROM attendance WHERE member_id=? ORDER BY date DESC LIMIT 1", (m['id'],)).fetchone()
        m['last_attendance'] = dict(last) if last else None
        paid = conn.execute("SELECT COALESCE(SUM(amount),0) as t FROM payments WHERE member_id=? AND period_year=? AND period_month=?",
            (m['id'], date.today().year, date.today().month)).fetchone()['t']
        m['paid_this_month'] = paid
    conn.close(); return jsonify(members)

@app.route('/api/members', methods=['POST'])
@login_required
def create_member():
    d = request.get_json(force=True, silent=True) or {}
    mid = str(uuid.uuid4()); now = datetime.now().isoformat(); conn = get_db()
    conn.execute("INSERT INTO members VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (mid,d['name'],d.get('email'),d.get('phone'),d.get('address'),d.get('date_of_birth'),
         d.get('emergency_contact'),d.get('emergency_phone'),d.get('notes'),'active',
         date.today().isoformat(),session.get('username'),None,None))
    for gid in d.get('group_ids',[]): conn.execute("INSERT OR IGNORE INTO group_members VALUES (?,?)",(gid,mid))
    audit(conn,'CREATE','members',mid,d['name'])
    conn.commit(); conn.close(); return jsonify({'id':mid})

@app.route('/api/members/<mid>', methods=['PUT'])
@login_required
def update_member(mid):
    d = request.get_json(force=True, silent=True) or {}
    now = datetime.now().isoformat(); conn = get_db()
    conn.execute("""UPDATE members SET name=?,email=?,phone=?,address=?,date_of_birth=?,
        emergency_contact=?,emergency_phone=?,notes=?,status=?,updated_by=?,updated_at=? WHERE id=?""",
        (d['name'],d.get('email'),d.get('phone'),d.get('address'),d.get('date_of_birth'),
         d.get('emergency_contact'),d.get('emergency_phone'),d.get('notes'),
         d.get('status','active'),session.get('username'),now,mid))
    if 'group_ids' in d:
        conn.execute("DELETE FROM group_members WHERE member_id=?", (mid,))
        for gid in d['group_ids']: conn.execute("INSERT OR IGNORE INTO group_members VALUES (?,?)",(gid,mid))
    audit(conn,'UPDATE','members',mid,d['name'])
    conn.commit(); conn.close(); return jsonify({'ok':True})

@app.route('/api/members/<mid>', methods=['DELETE'])
@login_required
def delete_member(mid):
    conn = get_db()
    m = conn.execute("SELECT name FROM members WHERE id=?", (mid,)).fetchone()
    audit(conn,'DELETE','members',mid,m['name'] if m else '')
    for tbl in ['group_members','attendance','payments','contacts','member_pricing']:
        conn.execute(f"DELETE FROM {tbl} WHERE member_id=?", (mid,))
    conn.execute("DELETE FROM members WHERE id=?", (mid,))
    conn.commit(); conn.close(); return jsonify({'ok':True})

@app.route('/api/members/<mid>/history')
@login_required
def member_history(mid):
    conn = get_db()
    rows = [dict(r) for r in conn.execute("""
        SELECT a.*, g.name as group_name FROM attendance a
        JOIN groups g ON g.id=a.group_id WHERE a.member_id=? ORDER BY a.date DESC""", (mid,)).fetchall()]
    conn.close(); return jsonify(rows)

@app.route('/api/groups/<gid>/members')
@login_required
def get_group_members(gid):
    conn = get_db()
    members = [dict(r) for r in conn.execute("""
        SELECT m.* FROM members m JOIN group_members gm ON gm.member_id=m.id
        WHERE gm.group_id=? AND m.status='active' ORDER BY m.name""", (gid,)).fetchall()]
    conn.close(); return jsonify(members)

@app.route('/api/groups/<gid>/members', methods=['POST'])
@login_required
def add_member_to_group(gid):
    d = request.get_json(force=True, silent=True) or {}; conn = get_db()
    conn.execute("INSERT OR IGNORE INTO group_members VALUES (?,?)", (gid,d['member_id']))
    conn.commit(); conn.close(); return jsonify({'ok':True})

@app.route('/api/groups/<gid>/members/<mid>', methods=['DELETE'])
@login_required
def remove_member_from_group(gid, mid):
    conn = get_db()
    conn.execute("DELETE FROM group_members WHERE group_id=? AND member_id=?", (gid,mid))
    conn.commit(); conn.close(); return jsonify({'ok':True})

# ── Member pricing ────────────────────────────────────────────────────────────
@app.route('/api/members/<mid>/pricing')
@login_required
def get_member_pricing(mid):
    conn = get_db()
    rows = [dict(r) for r in conn.execute("""
        SELECT mp.*, g.name as group_name FROM member_pricing mp
        JOIN groups g ON g.id=mp.group_id
        WHERE mp.member_id=? ORDER BY mp.valid_from DESC""", (mid,)).fetchall()]
    conn.close(); return jsonify(rows)

@app.route('/api/members/<mid>/pricing', methods=['POST'])
@login_required
def set_member_pricing(mid):
    d = request.get_json(force=True, silent=True) or {}
    conn = get_db(); now = datetime.now().isoformat()
    # Zapri prejšnjo ceno za isto skupino
    if d.get('close_previous'):
        conn.execute("""UPDATE member_pricing SET valid_to=? 
            WHERE member_id=? AND group_id=? AND valid_to IS NULL""",
            (d['valid_from'], mid, d['group_id']))
    pid = str(uuid.uuid4())
    conn.execute("INSERT INTO member_pricing VALUES (?,?,?,?,?,?,?,?,?)",
        (pid, mid, d['group_id'], int(d['visits_per_week']),
         float(d['monthly_price']), d['valid_from'],
         d.get('valid_to') or None, session.get('username'), now))
    audit(conn,'CREATE','member_pricing',pid,f"{mid} {d['monthly_price']}€/mes")
    conn.commit(); conn.close(); return jsonify({'id':pid})

@app.route('/api/pricing/<pid>', methods=['DELETE'])
@login_required
def delete_pricing(pid):
    conn = get_db(); audit(conn,'DELETE','member_pricing',pid)
    conn.execute("DELETE FROM member_pricing WHERE id=?", (pid,))
    conn.commit(); conn.close(); return jsonify({'ok':True})

# ── Member discount ───────────────────────────────────────────────────────────
@app.route('/api/members/<mid>/discount')
@login_required
def get_member_discount(mid):
    conn = get_db()
    row = conn.execute("SELECT * FROM member_discount WHERE member_id=?", (mid,)).fetchone()
    conn.close()
    return jsonify(dict(row) if row else None)

@app.route('/api/members/<mid>/discount', methods=['POST'])
@login_required
def set_member_discount(mid):
    d = request.get_json(force=True, silent=True) or {}
    conn = get_db(); now = datetime.now().isoformat()
    existing = conn.execute("SELECT id FROM member_discount WHERE member_id=?", (mid,)).fetchone()
    if existing:
        conn.execute("""UPDATE member_discount SET discount_type=?,discount_value=?,reason=?,
            valid_from=?,valid_to=?,created_by=?,created_at=? WHERE member_id=?""",
            (d['discount_type'], float(d['discount_value']), d.get('reason',''),
             d['valid_from'], d.get('valid_to') or None, session.get('username'), now, mid))
        did = existing['id']
    else:
        did = str(uuid.uuid4())
        conn.execute("INSERT INTO member_discount VALUES (?,?,?,?,?,?,?,?,?)",
            (did, mid, d['discount_type'], float(d['discount_value']),
             d.get('reason',''), d['valid_from'], d.get('valid_to') or None,
             session.get('username'), now))
    audit(conn,'UPSERT','member_discount',did,f"{mid} {d['discount_value']}{'%' if d['discount_type']=='percent' else '€'}")
    conn.commit(); conn.close(); return jsonify({'ok':True})

@app.route('/api/members/<mid>/discount', methods=['DELETE'])
@login_required
def delete_member_discount(mid):
    conn = get_db()
    conn.execute("DELETE FROM member_discount WHERE member_id=?", (mid,))
    conn.commit(); conn.close(); return jsonify({'ok':True})

# ── Attendance ────────────────────────────────────────────────────────────────
@app.route('/api/attendance/<gid>/<session_date>')
@login_required
def get_attendance(gid, session_date):
    conn = get_db()
    members = [dict(r) for r in conn.execute("""
        SELECT m.* FROM members m JOIN group_members gm ON gm.member_id=m.id
        WHERE gm.group_id=? AND m.status='active' ORDER BY m.name""", (gid,)).fetchall()]
    records = {r['member_id']:dict(r) for r in conn.execute(
        "SELECT * FROM attendance WHERE group_id=? AND date=?", (gid,session_date)).fetchall()}
    # Pridobi info o terminu (odpoved ipd.)
    sess_info = conn.execute("SELECT * FROM sessions WHERE group_id=? AND session_date=?", (gid,session_date)).fetchone()
    conn.close()
    for m in members: m['attendance'] = records.get(m['id'])
    return jsonify({'members':members, 'session_info': dict(sess_info) if sess_info else None})

@app.route('/api/attendance', methods=['POST'])
@login_required
def save_attendance():
    d = request.get_json(force=True, silent=True) or {}; conn = get_db(); now = datetime.now().isoformat()
    for rec in d['records']:
        mid,gid,sess_date = rec['member_id'],d['group_id'],d['date']
        status,absence_end = rec['status'],rec.get('absence_end_date')
        notes,makeup_for,makeup_gid = rec.get('notes'),rec.get('makeup_for_date'),rec.get('makeup_group_id')
        existing = conn.execute("SELECT id FROM attendance WHERE group_id=? AND member_id=? AND date=?",(gid,mid,sess_date)).fetchone()
        if existing:
            conn.execute("UPDATE attendance SET status=?,absence_end_date=?,notes=?,makeup_for_date=?,makeup_group_id=?,recorded_by=?,recorded_at=? WHERE id=?",
                (status,absence_end,notes,makeup_for,makeup_gid,session.get('username'),now,existing['id']))
        else:
            conn.execute("INSERT INTO attendance VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (str(uuid.uuid4()),gid,mid,sess_date,status,makeup_for,makeup_gid,absence_end,notes,session.get('username'),now))
        if status in ('absent_excused','absent_unexcused') and absence_end:
            group = conn.execute("SELECT day_of_week FROM groups WHERE id=?", (gid,)).fetchone()
            if group:
                cur = datetime.strptime(sess_date,'%Y-%m-%d').date() + timedelta(1)
                end = datetime.strptime(absence_end,'%Y-%m-%d').date()
                while cur <= end:
                    if cur.weekday() == group['day_of_week']:
                        if not conn.execute("SELECT id FROM attendance WHERE group_id=? AND member_id=? AND date=?",(gid,mid,cur.isoformat())).fetchone():
                            conn.execute("INSERT INTO attendance VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                                (str(uuid.uuid4()),gid,mid,cur.isoformat(),'absent_excused',None,None,absence_end,'Avtomatski vnos',session.get('username'),now))
                    cur += timedelta(1)
        if status=='makeup' and makeup_for and makeup_gid:
            if not conn.execute("SELECT id FROM attendance WHERE group_id=? AND member_id=? AND date=?",(makeup_gid,mid,sess_date)).fetchone():
                conn.execute("INSERT INTO attendance VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (str(uuid.uuid4()),makeup_gid,mid,sess_date,'makeup',makeup_for,gid,None,'Nadomeščanje termina',session.get('username'),now))
    audit(conn,'SAVE_ATTENDANCE','attendance',d['group_id'],d['date'])
    conn.commit(); conn.close(); return jsonify({'ok':True})

# ── Payments ──────────────────────────────────────────────────────────────────
@app.route('/api/members/<mid>/payments')
@login_required
def get_member_payments(mid):
    conn = get_db()
    rows = [dict(r) for r in conn.execute("SELECT * FROM payments WHERE member_id=? ORDER BY payment_date DESC", (mid,)).fetchall()]
    conn.close(); return jsonify(rows)

@app.route('/api/payments', methods=['POST'])
@login_required
def create_payment():
    d = request.get_json(force=True, silent=True) or {}
    pid = str(uuid.uuid4()); now = datetime.now().isoformat(); conn = get_db()
    conn.execute("INSERT INTO payments VALUES (?,?,?,?,?,?,?,?,?,?)",
        (pid, d['member_id'], float(d['amount']), d['payment_date'], d.get('method','gotovina'),
         int(d['period_year']), int(d['period_month']), d.get('notes',''), session.get('username'), now))
    audit(conn,'CREATE','payments',pid,f"{d['member_id']} {d['amount']}€")
    conn.commit(); conn.close(); return jsonify({'id':pid})

@app.route('/api/payments/<pid>', methods=['DELETE'])
@login_required
def delete_payment(pid):
    conn = get_db(); audit(conn,'DELETE','payments',pid)
    conn.execute("DELETE FROM payments WHERE id=?", (pid,))
    conn.commit(); conn.close(); return jsonify({'ok':True})

# ── Contacts ──────────────────────────────────────────────────────────────────
@app.route('/api/members/<mid>/contacts')
@login_required
def get_member_contacts(mid):
    conn = get_db()
    rows = [dict(r) for r in conn.execute("SELECT * FROM contacts WHERE member_id=? ORDER BY contact_date DESC", (mid,)).fetchall()]
    conn.close(); return jsonify(rows)

@app.route('/api/contacts', methods=['POST'])
@login_required
def create_contact():
    d = request.get_json(force=True, silent=True) or {}
    cid = str(uuid.uuid4()); now = datetime.now().isoformat(); conn = get_db()
    conn.execute("INSERT INTO contacts VALUES (?,?,?,?,?,?,?,?)",
        (cid, d['member_id'], d['contact_date'], d.get('type','klic'),
         d['notes'], d.get('followup_date'), session.get('username'), now))
    audit(conn,'CREATE','contacts',cid,d['member_id'])
    conn.commit(); conn.close(); return jsonify({'id':cid})

@app.route('/api/contacts/<cid>', methods=['DELETE'])
@login_required
def delete_contact(cid):
    conn = get_db(); audit(conn,'DELETE','contacts',cid)
    conn.execute("DELETE FROM contacts WHERE id=?", (cid,))
    conn.commit(); conn.close(); return jsonify({'ok':True})

# ── Billing ───────────────────────────────────────────────────────────────────
@app.route('/api/billing/<int:year>/<int:month>')
@login_required
def billing_overview(year, month):
    conn = get_db()
    discount_pct = float(get_setting(conn,'discount_percent','20')) / 100
    discount_days = int(get_setting(conn,'discount_days','7'))
    month_str = f"{year:04d}-{month:02d}"
    members = [dict(r) for r in conn.execute("SELECT * FROM members WHERE status='active' ORDER BY name").fetchall()]
    result = []
    for m in members:
        # Pridobi vse prisotnosti tega meseca za vse njegove skupine
        rows = conn.execute("""SELECT a.*,g.fee_per_session,g.id as grp_id,g.day_of_week
            FROM attendance a JOIN groups g ON g.id=a.group_id
            WHERE a.member_id=? AND strftime('%Y-%m',a.date)=?""", (m['id'],month_str)).fetchall()
        if not rows:
            result.append({'member_id':m['id'],'name':m['name'],'scheduled':0,'attended':0,
                'excused':0,'unexcused':0,'discount_sessions':0,'monthly_price':0,
                'base_amount':0,'discount_amount':0,'amount_due':0,'paid':0,'balance':0,'pricing_type':'none'})
            continue
        attended = sum(1 for r in rows if r['status'] in ('present','makeup'))
        excused = sum(1 for r in rows if r['status']=='absent_excused')
        unexcused = sum(1 for r in rows if r['status']=='absent_unexcused')
        # Preveri ali ima mesečno ceno
        group_ids = list({r['grp_id'] for r in rows})
        monthly_price = 0; pricing_type = 'per_session'
        for gid in group_ids:
            mp, vpw = get_member_price(conn, m['id'], gid, f"{year:04d}-{month:02d}-01")
            if mp > 0:
                monthly_price += mp; pricing_type = 'monthly'
        if pricing_type == 'monthly':
            # Mesečna cena — fiksna, popust samo pri daljši odsotnosti
            discount_sessions = 0
            for r in rows:
                if r['status']=='absent_excused' and r['absence_end_date']:
                    s = datetime.strptime(r['date'],'%Y-%m-%d').date()
                    e = datetime.strptime(r['absence_end_date'],'%Y-%m-%d').date()
                    if (e-s).days <= discount_days: discount_sessions += 1
            base = monthly_price
            discount = discount_sessions * (monthly_price / max(len(rows),1)) * discount_pct
        else:
            # Cena po sejo
            fee = rows[0]['fee_per_session']
            discount_sessions = 0
            for r in rows:
                if r['status']=='absent_excused' and r['absence_end_date']:
                    s = datetime.strptime(r['date'],'%Y-%m-%d').date()
                    e = datetime.strptime(r['absence_end_date'],'%Y-%m-%d').date()
                    if (e-s).days <= discount_days: discount_sessions += 1
            base = attended * fee
            monthly_price = base
            discount = discount_sessions * fee * discount_pct
        amount_due = base - discount
        # Individualni popust člana
        today_str = f"{year:04d}-{month:02d}-01"
        member_disc = conn.execute("""SELECT * FROM member_discount WHERE member_id=?
            AND valid_from<=? AND (valid_to IS NULL OR valid_to>=?)""",
            (m['id'], today_str, today_str)).fetchone()
        member_discount_amount = 0.0
        member_discount_label = None
        if member_disc:
            if member_disc['discount_type'] == 'percent':
                member_discount_amount = round(amount_due * float(member_disc['discount_value']) / 100, 2)
                member_discount_label = f"-{member_disc['discount_value']}%"
            else:  # fixed
                member_discount_amount = round(min(float(member_disc['discount_value']), amount_due), 2)
                member_discount_label = f"-€{member_disc['discount_value']:.2f}"
            amount_due = round(amount_due - member_discount_amount, 2)
        paid = conn.execute("SELECT COALESCE(SUM(amount),0) as t FROM payments WHERE member_id=? AND period_year=? AND period_month=?",
            (m['id'],year,month)).fetchone()['t']
        result.append({
            'member_id':m['id'],'name':m['name'],'scheduled':len(rows),
            'attended':attended,'excused':excused,'unexcused':unexcused,
            'discount_sessions':discount_sessions,'monthly_price':round(monthly_price,2),
            'base_amount':round(base,2),'discount_amount':round(discount,2),
            'member_discount_amount':member_discount_amount,
            'member_discount_label':member_discount_label,
            'amount_due':round(amount_due,2),'paid':round(paid,2),
            'balance':round(amount_due-paid,2),'pricing_type':pricing_type
        })
    conn.close(); return jsonify(result)

@app.route('/api/billing/<int:year>/<int:month>/csv')
@login_required
def billing_csv(year, month):
    data = billing_overview(year, month).get_json()
    si = io.StringIO(); w = csv.writer(si, delimiter=';')
    w.writerow(['Ime','Tip cene','Načrt.','Prisoten','Op.','Neop.','Osnova €','Pop. odsotnost €','Pop. član €','Dolguje €','Plačano €','Razlika €'])
    for r in data:
        w.writerow([r['name'],r['pricing_type'],r['scheduled'],r['attended'],r['excused'],r['unexcused'],
            f"{r['base_amount']:.2f}",f"{r['discount_amount']:.2f}",
            f"{r['member_discount_amount']:.2f}",
            f"{r['amount_due']:.2f}",f"{r['paid']:.2f}",f"{r['balance']:.2f}"])
    output = io.BytesIO(si.getvalue().encode('utf-8-sig'))
    return send_file(output, mimetype='text/csv', download_name=f'billing_{year}-{month:02d}.csv', as_attachment=True)

# ── Today ─────────────────────────────────────────────────────────────────────
@app.route('/api/today')
@login_required
def today_groups():
    today_dow = date.today().weekday(); conn = get_db()
    groups = [dict(r) for r in conn.execute("SELECT * FROM groups WHERE day_of_week=? ORDER BY time",(today_dow,)).fetchall()]
    for g in groups:
        g['day_name'] = DAYS_SL[g['day_of_week']]
        g['member_count'] = conn.execute(
            "SELECT COUNT(*) FROM group_members gm JOIN members m ON m.id=gm.member_id WHERE gm.group_id=? AND m.status='active'",(g['id'],)).fetchone()[0]
        g['attendance_done'] = conn.execute(
            "SELECT COUNT(*) FROM attendance WHERE group_id=? AND date=?",(g['id'],date.today().isoformat())).fetchone()[0] > 0
    week_start = date.today() - timedelta(days=date.today().weekday())
    week_end = week_start + timedelta(6)
    sessions_this_week = conn.execute(
        "SELECT COUNT(DISTINCT date||group_id) FROM attendance WHERE date BETWEEN ? AND ?",(week_start.isoformat(),week_end.isoformat())).fetchone()[0]
    active_members = conn.execute("SELECT COUNT(*) FROM members WHERE status='active'").fetchone()[0]
    unpaid = conn.execute("""SELECT COUNT(DISTINCT m.id) FROM members m
        WHERE m.status='active' AND NOT EXISTS (
            SELECT 1 FROM payments p WHERE p.member_id=m.id AND p.period_year=? AND p.period_month=?)""",
        (date.today().year, date.today().month)).fetchone()[0]
    conn.close()
    return jsonify({'today':date.today().strftime('%d.%m.%Y'),'day_name':DAYS_SL[date.today().weekday()],
        'groups':groups,'active_members':active_members,'sessions_this_week':sessions_this_week,'unpaid':unpaid})

init_db()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)

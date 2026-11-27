import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase } from './supabaseClient';
import {
  LayoutDashboard, Users, ClipboardList, CalendarDays, Plus, Trash2,
  Pencil, Check, X, AlertTriangle, ChevronLeft, ChevronRight, Loader2,
  ChevronDown, Save, ListChecks, Package, FileText, Download, Printer, Sparkles
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell
} from 'recharts';

const DEFAULT_TRADES = ['Piping', 'Civil', 'Mechanical', 'Electrical', 'Instrumentation'];
const STATUS_ORDER = ['Pending', 'In Progress', 'Completed'];
const STATUS_COLORS = { Pending: '#3D6178', 'In Progress': '#D98E2B', Completed: '#4F7C52', Overdue: '#B5482F' };
const PRIORITY_COLORS = { High: '#B5482F', Medium: '#D98E2B', Low: '#70796E' };

function todayStr() {
  // Local calendar date. Deliberately NOT toISOString(), which is UTC and runs a
  // day behind for part of every day in timezones ahead of UTC (e.g. India
  // between midnight and 5:30am).
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateShort(s) {
  const d = new Date(s + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}
function daysBetween(a, b) {
  const d1 = new Date(a + 'T00:00:00');
  const d2 = new Date(b + 'T00:00:00');
  return Math.round((d2 - d1) / 86400000);
}
function isDone(activity) {
  return activity.status === 'Completed' || !!activity.actualEnd;
}
// Which kind of overdue an activity is in, if any (never once it's done):
//  - 'notStarted': no actual start, and today is past the planned start
//    (falls back to the planned finish if no planned start was entered)
//  - 'delayed': started but not finished, and today is past the planned finish
function overdueKind(activity) {
  if (isDone(activity)) return null;
  const today = todayStr();
  if (!activity.actualStart) {
    const mustHaveStartedBy = activity.plannedStart || activity.plannedEnd;
    return mustHaveStartedBy && today > mustHaveStartedBy ? 'notStarted' : null;
  }
  return activity.plannedEnd && today > activity.plannedEnd ? 'delayed' : null;
}
function isOverdue(activity) {
  return overdueKind(activity) !== null;
}
function displayStatus(activity) {
  return isOverdue(activity) ? 'Overdue' : activity.status;
}
function percentComplete(a) {
  const total = Number(a.totalScope);
  const balance = Number(a.balanceScope);
  if (!total || total <= 0 || isNaN(balance)) return null;
  const pct = ((total - balance) / total) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

const CATEGORY_COLORS = {
  'Not yet started': '#70796E',
  'Planned and progressing as per plan': '#3D6178',
  'Completed as per Plan': '#4F7C52',
  'Completed with delay': '#8A7F3D',
  'Overdue not started': '#7A2E1F',
  'Overdue with delay': '#B5482F',
};
const CATEGORY_LIST = Object.keys(CATEGORY_COLORS);

function scheduleCategory(a) {
  if (isDone(a)) {
    if (a.actualEnd && a.plannedEnd) {
      return a.actualEnd > a.plannedEnd ? 'Completed with delay' : 'Completed as per Plan';
    }
    return 'Completed as per Plan';
  }
  const kind = overdueKind(a);
  if (kind === 'notStarted') return 'Overdue not started';
  if (kind === 'delayed') return 'Overdue with delay';
  // Not overdue: an activity with an actual start is progressing per plan;
  // one without hasn't kicked off yet (and isn't past its planned start).
  return a.actualStart ? 'Planned and progressing as per plan' : 'Not yet started';
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function normalizeKey(k) {
  return k.toString().toLowerCase().replace(/[^a-z0-9]/g, '');
}
function findValue(row, aliases) {
  for (const k of Object.keys(row)) {
    if (aliases.includes(normalizeKey(k))) return row[k];
  }
  return '';
}
function excelSerialToDateStr(serial) {
  // Excel's day-0 epoch is Dec 30 1899 (this compensates for Excel's
  // historical 1900-leap-year bug) — verified directly against this app's
  // own import template: serial 46296 -> 2026-10-01, serial 46305 ->
  // 2026-10-10. Pure local-calendar arithmetic, no timezone involved.
  const epoch = new Date(1899, 11, 30);
  epoch.setDate(epoch.getDate() + Math.round(serial));
  const y = epoch.getFullYear();
  const m = String(epoch.getMonth() + 1).padStart(2, '0');
  const d = String(epoch.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toDateStr(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number' && !isNaN(v)) {
    // A raw Excel serial date number. This is the normal path for imports now
    // that the file is read without cellDates (see handleImportFile), and it
    // involves no timezone math at all.
    return v > 0 ? excelSerialToDateStr(v) : '';
  }
  if (v instanceof Date && !isNaN(v.getTime())) {
    // Defensive only — Date objects shouldn't reach here for Excel imports any
    // more. If one does, SheetJS-built dates can sit seconds BEFORE local
    // midnight in some timezones (e.g. 23:59:50 the previous day in India),
    // so nudge forward an hour before reading the local calendar day. Safe for
    // date-only values, which are all this app stores.
    const t = new Date(v.getTime() + 60 * 60 * 1000);
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const day = String(t.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const s = String(v).trim();
  // If the cell came through as plain text rather than a real Excel date
  // (e.g. typed as "2026-09-01"), pull the calendar digits out directly
  // rather than routing through new Date(...).toISOString(), which is where
  // the same timezone-shift bug would otherwise sneak back in for text cells.
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    const [, y, m, day] = isoMatch;
    return `${y}-${m.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
function rowToActivity(row) {
  const name = String(findValue(row, ['activity', 'activityname', 'name', 'task', 'taskname'])).trim();
  const category = String(findValue(row, ['category', 'discipline', 'trade'])).trim();
  const area = String(findValue(row, ['area', 'zone', 'block', 'location'])).trim();
  const rawPriority = String(findValue(row, ['priority'])).trim().toLowerCase();
  const priority = ['high', 'medium', 'low'].includes(rawPriority)
    ? rawPriority[0].toUpperCase() + rawPriority.slice(1)
    : 'Medium';
  const plannedStart = toDateStr(findValue(row, ['plannedstart', 'startdate', 'start']));
  const plannedEnd = toDateStr(findValue(row, ['plannedfinish', 'plannedend', 'enddate', 'finish', 'end', 'duedate']));
  const actualStart = toDateStr(findValue(row, ['actualstart', 'actstart']));
  const actualEnd = toDateStr(findValue(row, ['actualfinish', 'actualend', 'actend', 'actfinish']));
  const assignedTo = String(findValue(row, ['assignedto', 'responsible', 'owner', 'assignee'])).trim();
  const notes = String(findValue(row, ['notes', 'remarks', 'description', 'comment', 'comments'])).trim();
  const unit = String(findValue(row, ['unit', 'uom'])).trim();
  const rawTotal = findValue(row, ['totalscope', 'scope', 'totalqty', 'totalquantity']);
  const rawBalance = findValue(row, ['balancescope', 'balance', 'remainingscope', 'remainingqty']);
  const totalScope = rawTotal === '' ? '' : String(rawTotal).trim();
  const balanceScope = rawBalance === '' ? '' : String(rawBalance).trim();
  return {
    id: uid(), name, category, area, priority, plannedStart, plannedEnd, actualStart, actualEnd,
    totalScope, balanceScope, unit, assignedTo, notes,
    status: 'Pending', createdAt: new Date().toISOString(),
  };
}

// Shared data (shared=true) is backed by a single Supabase table, `kv_store`,
// that mirrors the original window.storage model: one row per key, JSON value.
// Personal/per-device data (shared=false — just the remembered login and the
// last-viewed project) stays in localStorage rather than needing a real user
// auth system, since it's a device convenience, not data that needs to sync
// across devices or be visible to teammates.
async function safeGet(key, shared = true) {
  if (!shared) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  try {
    const { data, error } = await supabase.from('kv_store').select('value').eq('key', key).maybeSingle();
    if (error || !data) return null;
    return data.value;
  } catch (e) {
    return null;
  }
}
async function safeSet(key, value, shared = true) {
  if (!shared) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }
  try {
    const { error } = await supabase
      .from('kv_store')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    return !error;
  } catch (e) {
    return false;
  }
}
async function safeDelete(key, shared = true) {
  if (!shared) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (e) {
      return false;
    }
  }
  try {
    const { error } = await supabase.from('kv_store').delete().eq('key', key);
    return !error;
  } catch (e) {
    return false;
  }
}

const PROJECT_DATA_KEYS = [
  'trades-config', 'areas-config', 'subcontractors-config', 'manpower-entries', 'activities', 'daily-log-entries',
  'daily-log-subactivities', 'procurement-items', 'procurement-lots', 'procurement-updates',
  'mom-records',
];

function Badge({ label, color }) {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 text-xs rounded-sm border"
      style={{ color, borderColor: color, background: color + '14' }}
    >
      {label}
    </span>
  );
}

function StatLine({ value, label, color }) {
  return (
    <div className="flex flex-col items-start px-4 py-3 border-r last:border-r-0 min-w-[84px]" style={{borderColor: '#D9D2C2'}}>
      <span className="text-2xl font-semibold" style={{ color: color || '#2A2620', fontFamily: "'Barlow Condensed', sans-serif" }}>
        {value}
      </span>
      <span className="text-xs mt-0.5" style={{color: '#8B8578'}}>{label}</span>
    </div>
  );
}

function AuthScreen({ mode, setMode, form, setForm, onSubmit, error, busy, signupDone }) {
  if (signupDone) {
    return (
      <div
      className="w-full min-h-[600px] flex items-center justify-center p-4"
      style={{
        backgroundColor: '#1C2733',
        backgroundImage: 'linear-gradient(135deg, rgba(40,57,74,0.95) 0%, rgba(28,39,51,0.95) 65%), linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)',
        backgroundSize: 'cover, 24px 24px, 24px 24px',
        borderTop: '3px solid #D98E2B',
        fontFamily: "'Inter', sans-serif",
      }}
    >
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Inter:wght@400;500&display=swap');`}</style>
        <div className="w-full max-w-xs bg-white rounded-sm p-6 text-center" style={{ border: '1px solid #3D6178' }}>
          <h1 className="text-lg font-semibold mb-2" style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#1C2733' }}>
            Check your inbox
          </h1>
          <p className="text-xs" style={{ color: '#8B8578' }}>
            Account created. If email confirmation is required you'll get a confirmation link first — either way,
            an admin has been notified and needs to approve your account before you can sign in.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="w-full min-h-[600px] flex items-center justify-center p-4"
      style={{
        backgroundColor: '#1C2733',
        backgroundImage: 'linear-gradient(135deg, rgba(40,57,74,0.95) 0%, rgba(28,39,51,0.95) 65%), linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)',
        backgroundSize: 'cover, 24px 24px, 24px 24px',
        borderTop: '3px solid #D98E2B',
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Inter:wght@400;500&display=swap');`}</style>
      <div className="w-full max-w-xs bg-white rounded-sm p-6" style={{ border: '1px solid #3D6178' }}>
        <h1 className="text-xl font-semibold mb-1" style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#1C2733' }}>
          Construction Site Tracker
        </h1>
        <p className="text-xs mb-5" style={{ color: '#8B8578' }}>
          {mode === 'signin' ? 'Sign in to continue' : 'Create an account'}
        </p>

        <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Email</label>
        <input
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          className="w-full border rounded-sm px-2 py-1.5 text-sm mb-3" style={{ borderColor: '#D9D2C2' }}
          autoFocus
        />

        <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Password</label>
        <input
          type="password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
          className="w-full border rounded-sm px-2 py-1.5 text-sm mb-3" style={{ borderColor: '#D9D2C2' }}
        />

        {error && (
          <p className="text-xs mb-3" style={{ color: '#B5482F' }}>{error}</p>
        )}

        <button
          onClick={onSubmit}
          disabled={busy}
          className="w-full text-white px-3 py-2 rounded-sm text-sm font-medium flex items-center justify-center gap-1.5"
          style={{ backgroundColor: busy ? '#B7ADA0' : '#1C2733' }}
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          {mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>

        <button
          onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); }}
          className="w-full text-xs mt-3 underline"
          style={{ color: '#3D6178' }}
        >
          {mode === 'signin' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
        </button>

        <p className="text-xs mt-4" style={{ color: '#8B8578' }}>
          New accounts need approval from an admin before they can sign in.
        </p>
      </div>
    </div>
  );
}

function PendingApprovalScreen({ email, onSignOut }) {
  return (
    <div
      className="w-full min-h-[600px] flex items-center justify-center p-4"
      style={{
        backgroundColor: '#1C2733',
        backgroundImage: 'linear-gradient(135deg, rgba(40,57,74,0.95) 0%, rgba(28,39,51,0.95) 65%), linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)',
        backgroundSize: 'cover, 24px 24px, 24px 24px',
        borderTop: '3px solid #D98E2B',
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <div className="w-full max-w-xs bg-white rounded-sm p-6 text-center" style={{ border: '1px solid #D98E2B' }}>
        <h1 className="text-lg font-semibold mb-2" style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#1C2733' }}>
          Waiting for approval
        </h1>
        <p className="text-xs mb-4" style={{ color: '#8B8578' }}>
          {email} is signed up but hasn't been approved yet. An admin has been notified — try again once approved.
        </p>
        <button onClick={onSignOut} className="text-xs underline" style={{ color: '#3D6178' }}>Sign out</button>
      </div>
    </div>
  );
}

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [authMode, setAuthMode] = useState('signin');
  const [authForm, setAuthForm] = useState({ email: '', password: '' });
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [signupDone, setSignupDone] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState('dashboard');
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [editingName, setEditingName] = useState(false);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [confirmDeleteProject, setConfirmDeleteProject] = useState(false);
  const [trades, setTrades] = useState(DEFAULT_TRADES);
  const [areas, setAreas] = useState([]);
  const [subcontractors, setSubcontractors] = useState([]);
  const [manpower, setManpower] = useState({});
  const [activities, setActivities] = useState([]);
  const [dailyLog, setDailyLog] = useState([]);
  const [dailySubActivities, setDailySubActivities] = useState([]);
  const [procItems, setProcItems] = useState([]);
  const [procLots, setProcLots] = useState([]);
  const [procUpdates, setProcUpdates] = useState([]);
  const [momRecords, setMomRecords] = useState([]);

  const activeProject = projects.find(p => p.id === activeProjectId) || null;

  // Supabase Auth handles its own session persistence (localStorage under its
  // own key), so this just reads whatever session already exists on load and
  // then stays in sync with sign-in/sign-out events.
  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setAuthChecked(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => { mounted = false; listener.subscription.unsubscribe(); };
  }, []);

  // Once signed in, load this user's profile row to check approved/is_admin.
  useEffect(() => {
    if (!session) { setProfile(null); setProfileError(''); return; }
    let cancelled = false;
    setProfileLoading(true);
    setProfileError('');
    (async () => {
      const { data, error } = await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
      if (cancelled) return;
      if (error) {
        setProfile(null);
        setProfileError(error.message);
      } else if (!data) {
        setProfile(null);
        setProfileError('No account record found for this login. The one-time database setup may not be finished yet — contact an admin.');
      } else {
        setProfile(data);
      }
      setProfileLoading(false);
    })();
    return () => { cancelled = true; };
  }, [session]);

  const handleAuthSubmit = async () => {
    if (!authForm.email.trim() || !authForm.password) {
      setAuthError('Enter both email and password.');
      return;
    }
    setAuthBusy(true);
    setAuthError('');
    if (authMode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({
        email: authForm.email.trim(), password: authForm.password,
      });
      setAuthBusy(false);
      if (error) setAuthError(error.message);
    } else {
      const { error } = await supabase.auth.signUp({
        email: authForm.email.trim(), password: authForm.password,
      });
      if (error) {
        setAuthBusy(false);
        setAuthError(error.message);
        return;
      }
      // Best-effort — don't block the signup flow if the email notification fails.
      try {
        await supabase.functions.invoke('notify-signup', { body: { email: authForm.email.trim() } });
      } catch (e) { /* ignore — admin can still see them in the Admin tab */ }
      setAuthBusy(false);
      setSignupDone(true);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setAuthForm({ email: '', password: '' });
    setSignupDone(false);
  };

  // Phase 1: load (or migrate/initialize) the project list, then resolve which project is active.
  // Gated on approval — kv_store's RLS policy blocks unapproved users anyway, so there's no
  // point trying (or showing a stuck spinner) before that's true.
  useEffect(() => {
    if (!profile?.approved) return;
    (async () => {
      let list = await safeGet('projects-list', true);

      if (!list) {
        // One-time migration: if pre-multi-project data exists under the old flat keys, adopt it.
        const legacyMeta = await safeGet('project-meta', true);
        const legacyActivities = await safeGet('activities', true);
        const hasLegacyData = legacyMeta || legacyActivities;
        const newId = uid();
        if (hasLegacyData) {
          for (const k of PROJECT_DATA_KEYS) {
            const val = await safeGet(k, true);
            if (val !== null) await safeSet(`${k}:${newId}`, val, true);
          }
        }
        list = [{ id: newId, name: (legacyMeta && legacyMeta.name) || 'Construction Site Tracker', createdAt: new Date().toISOString() }];
        await safeSet('projects-list', list, true);
      }

      setProjects(list);

      let active = await safeGet('active-project-id', false);
      const activeId = active && active.id;
      const resolved = list.find(p => p.id === activeId) ? activeId : list[0]?.id;
      if (resolved && resolved !== activeId) {
        await safeSet('active-project-id', { id: resolved }, false);
      }
      setActiveProjectId(resolved || null);
      setProjectsLoading(false);
    })();
  }, [profile?.approved]);

  // Phase 2: whenever the active project changes, load its data.
  useEffect(() => {
    if (!activeProjectId) { setDataLoading(false); return; }
    (async () => {
      setDataLoading(true);
      const suf = activeProjectId;
      const [tr, ar, sc, mp, act, dl, dsa, pi, pl, pu, mr] = await Promise.all([
        safeGet(`trades-config:${suf}`),
        safeGet(`areas-config:${suf}`),
        safeGet(`subcontractors-config:${suf}`),
        safeGet(`manpower-entries:${suf}`),
        safeGet(`activities:${suf}`),
        safeGet(`daily-log-entries:${suf}`),
        safeGet(`daily-log-subactivities:${suf}`),
        safeGet(`procurement-items:${suf}`),
        safeGet(`procurement-lots:${suf}`),
        safeGet(`procurement-updates:${suf}`),
        safeGet(`mom-records:${suf}`),
      ]);
      setTrades(tr || DEFAULT_TRADES);
      let resolvedAreas = ar;
      if (!resolvedAreas) {
        const seeded = Array.from(new Set((act || []).map(a => a.area).filter(Boolean))).sort();
        resolvedAreas = seeded;
        if (seeded.length > 0) await safeSet(`areas-config:${suf}`, seeded, true);
      }
      setAreas(resolvedAreas);
      setSubcontractors(sc || []);
      setManpower(mp || {});
      setActivities(act || []);
      setDailyLog(dl || []);
      setDailySubActivities(dsa || []);
      setProcItems(pi || []);
      setProcLots(pl || []);
      setProcUpdates(pu || []);
      setMomRecords(mr || []);
      setDataLoading(false);
    })();
  }, [activeProjectId]);

  const persist = useCallback(async (key, value, shared = true) => {
    setSaving(true);
    await safeSet(key, value, shared);
    setSaving(false);
  }, []);

  const switchProject = async (id) => {
    if (id === activeProjectId) return;
    setActiveProjectId(id);
    setShowProjectMenu(false);
    setConfirmDeleteProject(false);
    await safeSet('active-project-id', { id }, false);
  };

  const addProject = async () => {
    const n = { id: uid(), name: `Project ${projects.length + 1}`, createdAt: new Date().toISOString() };
    const list = [...projects, n];
    setProjects(list);
    await persist('projects-list', list, true);
    await switchProject(n.id);
    setEditingName(true);
  };

  const saveProjectName = (name) => {
    const trimmed = name.trim() || activeProject?.name || 'Untitled project';
    const list = projects.map(p => p.id === activeProjectId ? { ...p, name: trimmed } : p);
    setProjects(list);
    persist('projects-list', list, true);
  };

  const deleteActiveProject = async () => {
    if (!activeProjectId) return;
    const remaining = projects.filter(p => p.id !== activeProjectId);
    const momList = await safeGet(`mom-records:${activeProjectId}`, true);
    if (momList) {
      for (const rec of momList) {
        await safeDelete(`mom-file:${activeProjectId}:${rec.id}`, true);
      }
    }
    for (const k of PROJECT_DATA_KEYS) {
      await safeDelete(`${k}:${activeProjectId}`, true);
    }
    let finalList = remaining;
    if (finalList.length === 0) {
      finalList = [{ id: uid(), name: 'Project 1', createdAt: new Date().toISOString() }];
    }
    setProjects(finalList);
    await persist('projects-list', finalList, true);
    setConfirmDeleteProject(false);
    await switchProject(finalList[0].id);
  };

  const saveTrades = (list) => {
    setTrades(list);
    persist(`trades-config:${activeProjectId}`, list);
  };
  const saveAreas = (list) => {
    setAreas(list);
    persist(`areas-config:${activeProjectId}`, list);
  };
  const saveSubcontractors = (list) => {
    setSubcontractors(list);
    persist(`subcontractors-config:${activeProjectId}`, list);
  };
  const saveManpower = (obj) => {
    setManpower(obj);
    persist(`manpower-entries:${activeProjectId}`, obj);
  };
  const saveActivities = (list) => {
    setActivities(list);
    persist(`activities:${activeProjectId}`, list);
  };
  const saveDailyLog = (list) => {
    setDailyLog(list);
    persist(`daily-log-entries:${activeProjectId}`, list);
  };
  const saveDailySubActivities = (list) => {
    setDailySubActivities(list);
    persist(`daily-log-subactivities:${activeProjectId}`, list);
  };
  const saveProcItems = (list) => {
    setProcItems(list);
    persist(`procurement-items:${activeProjectId}`, list);
  };
  const saveProcLots = (list) => {
    setProcLots(list);
    persist(`procurement-lots:${activeProjectId}`, list);
  };
  const saveProcUpdates = (list) => {
    setProcUpdates(list);
    persist(`procurement-updates:${activeProjectId}`, list);
  };
  const saveMomRecords = (list) => {
    setMomRecords(list);
    persist(`mom-records:${activeProjectId}`, list);
  };

  // Keep each activity's Balance Scope in sync with cumulative Actual Qty logged against it
  // in the Daily Log. Only applies to activities that have a Total Scope set AND at least one
  // Daily Log entry — an activity with no daily entries yet (e.g. just imported from Excel with
  // its own starting Balance Scope) is left alone rather than reset to "0 progress." Runs after
  // data for the active project has finished loading, and only writes when a value actually changed.
  useEffect(() => {
    if (dataLoading || !activeProjectId) return;
    const actualByActivity = {};
    dailyLog.forEach(e => {
      if (!e.activityId) return;
      actualByActivity[e.activityId] = (actualByActivity[e.activityId] || 0) + Number(e.actualQty || 0);
    });
    let changed = false;
    const updated = activities.map(a => {
      const total = Number(a.totalScope);
      if (!a.totalScope || isNaN(total) || total <= 0) return a;
      if (!(a.id in actualByActivity)) return a;
      const loggedActual = actualByActivity[a.id];
      const newBalance = Math.max(0, Math.round((total - loggedActual) * 100) / 100);
      if (Number(a.balanceScope) === newBalance && a.balanceScope !== '') return a;
      changed = true;
      return { ...a, balanceScope: newBalance };
    });
    if (changed) saveActivities(updated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyLog, activities, dataLoading, activeProjectId]);

  const overdueCount = useMemo(() => activities.filter(isOverdue).length, [activities]);
  const pendingCount = useMemo(() => activities.filter(a => a.status === 'Pending' && !isDone(a) && !isOverdue(a)).length, [activities]);
  const progressCount = useMemo(() => activities.filter(a => a.status === 'In Progress' && !isDone(a) && !isOverdue(a)).length, [activities]);
  const completedCount = useMemo(() => activities.filter(isDone).length, [activities]);

  if (!authChecked) {
    return (
      <div className="w-full h-full min-h-[500px] flex items-center justify-center" style={{backgroundColor: '#F1EDE4'}}>
        <Loader2 className="animate-spin" style={{color: '#3D6178'}} size={28} />
      </div>
    );
  }

  if (!session) {
    return (
      <AuthScreen
        mode={authMode}
        setMode={setAuthMode}
        form={authForm}
        setForm={setAuthForm}
        onSubmit={handleAuthSubmit}
        error={authError}
        busy={authBusy}
        signupDone={signupDone}
      />
    );
  }

  if (profileLoading) {
    return (
      <div className="w-full h-full min-h-[500px] flex items-center justify-center" style={{backgroundColor: '#F1EDE4'}}>
        <Loader2 className="animate-spin" style={{color: '#3D6178'}} size={28} />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="w-full min-h-[600px] flex items-center justify-center p-4" style={{ backgroundColor: '#1C2733' }}>
        <div className="w-full max-w-xs bg-white rounded-sm p-6 text-center" style={{ border: '1px solid #B5482F' }}>
          <h1 className="text-lg font-semibold mb-2" style={{ fontFamily: "'Barlow Condensed', sans-serif", color: '#1C2733' }}>
            Couldn't load your account
          </h1>
          <p className="text-xs mb-4" style={{ color: '#8B8578' }}>{profileError || 'Something went wrong loading your account.'}</p>
          <button onClick={handleSignOut} className="text-xs underline" style={{ color: '#3D6178' }}>Sign out</button>
        </div>
      </div>
    );
  }

  if (!profile.approved) {
    return <PendingApprovalScreen email={profile.email} onSignOut={handleSignOut} />;
  }

  if (projectsLoading) {
    return (
      <div className="w-full h-full min-h-[500px] flex items-center justify-center" style={{backgroundColor: '#F1EDE4'}}>
        <Loader2 className="animate-spin" style={{color: '#3D6178'}} size={28} />
      </div>
    );
  }

  return (
    <div
      className="w-full min-h-[600px]"
      style={{
        backgroundColor: '#F1EDE4',
        backgroundImage: 'linear-gradient(rgba(61,97,120,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(61,97,120,0.08) 1px, transparent 1px)',
        backgroundSize: '28px 28px',
        color: '#2A2620',
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        input[type="date"]::-webkit-calendar-picker-indicator { cursor: pointer; }
        .tracker-card { box-shadow: 0 1px 2px rgba(28,39,51,0.06), 0 4px 10px -4px rgba(28,39,51,0.12); }
      `}</style>

      {/* Header */}
      <div
        className="px-4 py-3 flex items-center justify-between"
        style={{
          backgroundColor: '#1C2733',
          backgroundImage: 'linear-gradient(135deg, rgba(40,57,74,0.95) 0%, rgba(28,39,51,0.95) 65%), linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)',
          backgroundSize: 'cover, 24px 24px, 24px 24px',
          color: '#F1EDE4',
          borderTop: '3px solid #D98E2B',
        }}
      >
        <div className="flex items-center gap-2 min-w-0 relative">
          {editingName ? (
            <input
              autoFocus
              defaultValue={activeProject?.name || ''}
              onBlur={(e) => { saveProjectName(e.target.value); setEditingName(false); }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
              className="px-2 py-1 rounded-sm text-lg outline-none border"
              style={{ backgroundColor: '#28394A', color: '#F1EDE4', borderColor: '#3D6178', fontFamily: "'Barlow Condensed', sans-serif" }}
            />
          ) : (
            <button
              className="flex items-center gap-1 min-w-0"
              onClick={() => setShowProjectMenu(v => !v)}
            >
              <h1 className="text-xl font-semibold truncate" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
                {activeProject?.name || 'Untitled project'}
              </h1>
              <ChevronDown size={16} style={{ color: '#8FA3B3' }} />
            </button>
          )}
          {!editingName && (
            <Pencil
              size={13} className="cursor-pointer shrink-0" style={{ color: '#6E7F8F' }}
              onClick={() => { setEditingName(true); setShowProjectMenu(false); }}
            />
          )}

          {showProjectMenu && !editingName && (
            <div className="absolute left-0 top-full mt-1 w-60 rounded-sm border overflow-hidden z-20" style={{ backgroundColor: '#243646', borderColor: '#0F1720' }}>
              {projects.map(p => (
                <button
                  key={p.id}
                  onClick={() => switchProject(p.id)}
                  className="w-full text-left px-3 py-2 text-sm flex items-center justify-between"
                  style={{
                    color: p.id === activeProjectId ? '#F1EDE4' : '#8FA3B3',
                    backgroundColor: p.id === activeProjectId ? '#1C2733' : 'transparent',
                  }}
                >
                  <span className="truncate">{p.name}</span>
                  {p.id === activeProjectId && <Check size={14} />}
                </button>
              ))}
              <button
                onClick={addProject}
                className="w-full text-left px-3 py-2 text-sm flex items-center gap-1.5 border-t"
                style={{ color: '#8FA3B3', borderColor: '#0F1720' }}
              >
                <Plus size={14} /> New project
              </button>
              <div className="border-t px-3 py-2" style={{ borderColor: '#0F1720' }}>
                {confirmDeleteProject ? (
                  <div className="space-y-1.5">
                    <p className="text-xs" style={{ color: '#E8A9A0' }}>Delete "{activeProject?.name}"? This removes all its data for everyone.</p>
                    <div className="flex gap-2">
                      <button onClick={deleteActiveProject} className="text-xs px-2 py-1 rounded-sm" style={{ backgroundColor: '#B5482F', color: 'white' }}>Delete</button>
                      <button onClick={() => setConfirmDeleteProject(false)} className="text-xs px-2 py-1 rounded-sm border" style={{ borderColor: '#3D6178', color: '#8FA3B3' }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setConfirmDeleteProject(true)} className="flex items-center gap-1.5 text-xs" style={{ color: '#C97B6B' }}>
                    <Trash2 size={12} /> Delete this project
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs shrink-0 ml-2" style={{color: '#8FA3B3'}}>
          {(saving || dataLoading) && <Loader2 size={13} className="animate-spin" />}
          <span>{fmtDate(todayStr())}</span>
          {profile?.is_admin && (
            <button onClick={() => setView('admin')} className="underline" style={{color: '#8FA3B3'}}>Admin</button>
          )}
          <button onClick={handleSignOut} className="underline" style={{color: '#8FA3B3'}}>Sign out</button>
        </div>
      </div>


      {/* Nav tabs */}
      <div className="flex overflow-x-auto border-b" style={{backgroundColor: '#243646', borderColor: '#0F1720'}}>
        {[
          { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
          { id: 'manpower', label: 'Manpower', icon: Users },
          { id: 'activities', label: 'Activities', icon: ClipboardList },
          { id: 'dailylog', label: 'Daily Log', icon: ListChecks },
          { id: 'procurement', label: 'Procurement', icon: Package },
          { id: 'mom', label: 'MOM / Notes', icon: FileText },
          { id: 'reports', label: 'Reports', icon: Download },
          { id: 'insights', label: 'Insights', icon: Sparkles },
          { id: 'timeline', label: 'Timeline', icon: CalendarDays },
        ].map(t => {
          const Icon = t.icon;
          const active = view === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setView(t.id)}
              className="flex items-center gap-1.5 px-4 py-2.5 text-sm whitespace-nowrap border-b-2 transition-all"
              style={{
                borderColor: active ? '#D98E2B' : 'transparent',
                borderBottomWidth: active ? '3px' : '2px',
                color: active ? '#F1EDE4' : '#8FA3B3',
                backgroundColor: active ? 'rgba(217,142,43,0.08)' : 'transparent',
                boxShadow: active ? '0 2px 10px -2px rgba(217,142,43,0.65)' : 'none',
              }}
            >
              <Icon size={15} />
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="p-4">
        {view === 'dashboard' && (
          <Dashboard
            manpower={manpower}
            trades={trades}
            subcontractors={subcontractors}
            activities={activities}
            overdueCount={overdueCount}
            pendingCount={pendingCount}
            progressCount={progressCount}
            completedCount={completedCount}
            goTo={setView}
          />
        )}
        {view === 'manpower' && (
          <ManpowerPage
            manpower={manpower} trades={trades} saveManpower={saveManpower} saveTrades={saveTrades}
            subcontractors={subcontractors} saveSubcontractors={saveSubcontractors}
          />
        )}
        {view === 'activities' && (
          <ActivitiesPage activities={activities} saveActivities={saveActivities} trades={trades} areas={areas} saveAreas={saveAreas} />
        )}
        {view === 'dailylog' && (
          <DailyLogPage
            activities={activities} manpower={manpower} dailyLog={dailyLog} saveDailyLog={saveDailyLog}
            subActivities={dailySubActivities} saveSubActivities={saveDailySubActivities} areas={areas}
            subcontractors={subcontractors}
          />
        )}
        {view === 'procurement' && (
          <ProcurementPage
            trades={trades} items={procItems} saveItems={saveProcItems}
            lots={procLots} saveLots={saveProcLots}
            updates={procUpdates} saveUpdates={saveProcUpdates}
          />
        )}
        {view === 'mom' && (
          <MOMPage records={momRecords} saveRecords={saveMomRecords} projectId={activeProjectId} />
        )}
        {view === 'insights' && (
          <InsightsPage
            projectName={activeProject?.name}
            activities={activities} manpower={manpower} dailyLog={dailyLog} subActivities={dailySubActivities}
            procItems={procItems} procLots={procLots} procUpdates={procUpdates} momRecords={momRecords}
            trades={trades} areas={areas} subcontractors={subcontractors}
          />
        )}
        {view === 'reports' && (
          <ReportsPage
            projectName={activeProject?.name}
            activities={activities} manpower={manpower} trades={trades}
            procItems={procItems} procLots={procLots} procUpdates={procUpdates}
          />
        )}
        {view === 'timeline' && (
          <TimelinePage activities={activities} procItems={procItems} procLots={procLots} areas={areas} trades={trades} />
        )}
        {view === 'admin' && profile?.is_admin && (
          <AdminPage currentUserId={session.user.id} />
        )}
      </div>
    </div>
  );
}

/* ---------------- Dashboard ---------------- */
function Dashboard({ manpower, trades, subcontractors, activities, overdueCount, pendingCount, progressCount, completedCount, goTo }) {
  const today = todayStr();
  const todayEntry = manpower[today];
  const todayTotal = todayEntry ? Object.values(todayEntry.trades || {}).reduce((a, b) => a + Number(b || 0), 0) : 0;

  const attention = useMemo(() => {
    return activities
      .filter(a => !isDone(a) && a.plannedEnd)
      .filter(a => isOverdue(a) || daysBetween(today, a.plannedEnd) <= 3)
      .sort((a, b) => (a.plannedEnd < b.plannedEnd ? -1 : 1))
      .slice(0, 6);
  }, [activities, today]);

  return (
    <div className="space-y-5">
      <div className="bg-white border flex flex-wrap rounded-sm overflow-hidden" style={{borderColor: '#D9D2C2'}}>
        <StatLine value={todayTotal} label="on site today" color="#1C2733" />
        <StatLine value={pendingCount} label="pending" color="#3D6178" />
        <StatLine value={progressCount} label="in progress" color="#D98E2B" />
        <StatLine value={overdueCount} label="overdue" color="#B5482F" />
        <StatLine value={completedCount} label="completed" color="#4F7C52" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="tracker-card bg-white border rounded-sm p-4" style={{borderColor: '#D9D2C2'}}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>Today's manpower</h2>
            <button onClick={() => goTo('manpower')} className="text-xs hover:underline" style={{color: '#3D6178'}}>Update entry</button>
          </div>
          {todayEntry ? (
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(todayEntry.trades || {}).filter(([, v]) => Number(v) > 0).map(([trade, count]) => (
                  <tr key={trade} className="border-b last:border-b-0" style={{borderColor: '#EEE8DA'}}>
                    <td className="py-1.5" style={{color: '#4A453C'}}>{trade}</td>
                    <td className="py-1.5 text-right font-medium">{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm" style={{color: '#8B8578'}}>No manpower entry logged for today yet.</p>
          )}
        </div>

        <div className="tracker-card bg-white border rounded-sm p-4" style={{borderColor: '#D9D2C2'}}>
          <h2 className="text-lg font-semibold mb-3" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>Needs attention</h2>
          {attention.length === 0 ? (
            <p className="text-sm" style={{color: '#8B8578'}}>Nothing overdue or due soon.</p>
          ) : (
            <ul className="space-y-2">
              {attention.map(a => (
                <li key={a.id} className="flex items-center justify-between border-l-2 pl-2 py-1" style={{ borderColor: isOverdue(a) ? '#B5482F' : '#D98E2B' }}>
                  <div className="min-w-0">
                    <p className="text-sm truncate">{a.name}</p>
                    <p className="text-xs" style={{color: '#8B8578'}}>Due {fmtDate(a.plannedEnd)}</p>
                  </div>
                  <Badge label={displayStatus(a)} color={STATUS_COLORS[displayStatus(a)]} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ManpowerTrackerCard manpower={manpower} trades={trades} subcontractors={subcontractors} />
    </div>
  );
}

/* ---------------- Manpower tracker (dashboard) ---------------- */
// Headcount for one logged day, optionally narrowed to a discipline and/or a
// subcontractor ('All' means no narrowing). With a subcontractor selected, only
// manpower attributed to that subcontractor in the discipline breakdowns counts —
// disciplines logged without a breakdown contribute nothing in that case.
function manpowerForDay(entry, disciplineFilter, subcontractorFilter) {
  if (!entry) return 0;
  const trades = entry.trades || {};
  const breakdown = entry.subBreakdown || {};
  if (subcontractorFilter === 'All') {
    if (disciplineFilter === 'All') return Object.values(trades).reduce((a, b) => a + Number(b || 0), 0);
    return Number(trades[disciplineFilter] || 0);
  }
  const disciplines = disciplineFilter === 'All' ? Object.keys(breakdown) : [disciplineFilter];
  return disciplines.reduce((sum, disc) => {
    const rows = (breakdown[disc] || []).filter(r => r.subcontractor === subcontractorFilter);
    return sum + rows.reduce((s, r) => s + Number(r.count || 0), 0);
  }, 0);
}

// Options for the dashboard's Discipline and Subcontractor dropdowns. The two
// depend on each other: picking a discipline narrows the subcontractors to those
// with manpower recorded under it, and picking a subcontractor narrows the
// disciplines to those it has worked in. With neither picked, everything is offered
// (the project's managed lists plus anything found in logged data).
function manpowerFilterOptions(manpower, trades, subcontractors, disciplineFilter, subcontractorFilter) {
  const allDisciplines = new Set(trades);
  const allSubcontractors = new Set(subcontractors);
  const pairs = []; // [discipline, subcontractor] combinations that have manpower recorded
  Object.values(manpower).forEach(entry => {
    Object.keys(entry.trades || {}).forEach(d => allDisciplines.add(d));
    Object.entries(entry.subBreakdown || {}).forEach(([disc, rows]) => {
      allDisciplines.add(disc);
      (rows || []).forEach(r => {
        if (!r.subcontractor) return;
        allSubcontractors.add(r.subcontractor);
        if (Number(r.count || 0) > 0) pairs.push([disc, r.subcontractor]);
      });
    });
  });
  let disciplineOptions = Array.from(allDisciplines);
  let subcontractorOptions = Array.from(allSubcontractors);
  if (subcontractorFilter !== 'All') {
    const ok = new Set(pairs.filter(([, s]) => s === subcontractorFilter).map(([d]) => d));
    disciplineOptions = disciplineOptions.filter(d => ok.has(d));
  }
  if (disciplineFilter !== 'All') {
    const ok = new Set(pairs.filter(([d]) => d === disciplineFilter).map(([, s]) => s));
    subcontractorOptions = subcontractorOptions.filter(s => ok.has(s));
  }
  return { disciplineOptions, subcontractorOptions };
}

function ManpowerTrackerCard({ manpower, trades = [], subcontractors = [] }) {
  const [mode, setMode] = useState('daily');
  const [disciplineFilter, setDisciplineFilter] = useState('All');
  const [subcontractorFilter, setSubcontractorFilter] = useState('All');

  // Cascading options: each dropdown only offers values that exist together with the
  // other dropdown's current selection (see manpowerFilterOptions).
  const { disciplineOptions, subcontractorOptions } = useMemo(
    () => manpowerFilterOptions(manpower, trades, subcontractors, disciplineFilter, subcontractorFilter),
    [manpower, trades, subcontractors, disciplineFilter, subcontractorFilter]
  );

  // If the selected option no longer exists (e.g. after switching projects), fall back to All.
  useEffect(() => {
    if (disciplineFilter !== 'All' && !disciplineOptions.includes(disciplineFilter)) setDisciplineFilter('All');
    if (subcontractorFilter !== 'All' && !subcontractorOptions.includes(subcontractorFilter)) setSubcontractorFilter('All');
  }, [disciplineOptions, subcontractorOptions, disciplineFilter, subcontractorFilter]);

  const dailyData = useMemo(() => {
    return Object.keys(manpower).sort().map(d => ({
      date: d,
      label: fmtDateShort(d),
      total: manpowerForDay(manpower[d], disciplineFilter, subcontractorFilter),
    }));
  }, [manpower, disciplineFilter, subcontractorFilter]);

  const monthlyData = useMemo(() => {
    const byMonth = {};
    dailyData.forEach(d => {
      const mk = d.date.slice(0, 7);
      byMonth[mk] = (byMonth[mk] || 0) + d.total;
    });
    return Object.keys(byMonth).sort().map(mk => ({
      date: mk,
      label: new Date(mk + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
      total: byMonth[mk],
    }));
  }, [dailyData]);

  const source = mode === 'daily' ? dailyData : monthlyData;
  const windowSize = mode === 'daily' ? 14 : 6;
  const levels = source.slice(-windowSize);

  const changeData = useMemo(() => {
    const withLead = source.slice(-(windowSize + 1));
    return withLead.slice(1).map((d, i) => ({
      label: d.label,
      change: d.total - withLead[i].total,
    }));
  }, [source, windowSize]);

  const latest = levels[levels.length - 1];
  const latestChange = changeData[changeData.length - 1];

  return (
    <div className="tracker-card bg-white border rounded-sm p-4" style={{borderColor: '#D9D2C2'}}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-lg font-semibold" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>Manpower tracker</h2>
        <div className="flex gap-1">
          {['daily', 'monthly'].map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className="px-3 py-1 text-xs rounded-sm border capitalize"
              style={{
                background: mode === m ? '#1C2733' : 'white',
                color: mode === m ? 'white' : '#4A453C',
                borderColor: mode === m ? '#1C2733' : '#D9D2C2',
              }}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 mb-3">
        <div>
          <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Discipline</label>
          <select
            value={disciplineFilter}
            onChange={(e) => setDisciplineFilter(e.target.value)}
            className="border rounded-sm px-2 py-1.5 text-sm bg-white" style={{ borderColor: '#D9D2C2' }}
          >
            <option value="All">All disciplines</option>
            {disciplineOptions.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Subcontractor</label>
          <select
            value={subcontractorFilter}
            onChange={(e) => setSubcontractorFilter(e.target.value)}
            disabled={subcontractorOptions.length === 0}
            className="border rounded-sm px-2 py-1.5 text-sm bg-white" style={{ borderColor: '#D9D2C2' }}
          >
            <option value="All">All subcontractors</option>
            {subcontractorOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {(disciplineFilter !== 'All' || subcontractorFilter !== 'All') && (
          <button
            onClick={() => { setDisciplineFilter('All'); setSubcontractorFilter('All'); }}
            className="text-xs underline" style={{ color: '#3D6178' }}
          >
            Reset filters
          </button>
        )}
      </div>
      {subcontractorFilter !== 'All' && (
        <p className="text-xs mb-3" style={{ color: '#8B8578' }}>
          Counts only manpower recorded against {subcontractorFilter} in the Manpower tab's subcontractor breakdown.
        </p>
      )}
      {disciplineFilter !== 'All' && subcontractorOptions.length === 0 && (
        <p className="text-xs mb-3" style={{ color: '#8B8578' }}>
          No subcontractor breakdown has been recorded under {disciplineFilter}, so there's nothing to filter by here.
        </p>
      )}

      {levels.length === 0 ? (
        <p className="text-sm" style={{color: '#8B8578'}}>No manpower entries logged yet.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-8 mb-4">
            <div>
              <p className="text-xs" style={{color: '#8B8578'}}>{mode === 'daily' ? "Today's manpower" : "This month's manpower"}</p>
              <p className="text-2xl font-semibold" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>{latest ? latest.total : '—'}</p>
            </div>
            <div>
              <p className="text-xs" style={{color: '#8B8578'}}>{mode === 'daily' ? 'Change vs yesterday' : 'Change vs last month'}</p>
              <p
                className="text-2xl font-semibold"
                style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  color: latestChange ? (latestChange.change >= 0 ? '#4F7C52' : '#B5482F') : '#2A2620',
                }}
              >
                {latestChange ? (latestChange.change > 0 ? '+' : '') + latestChange.change : '—'}
              </p>
            </div>
          </div>

          <p className="text-xs mb-1" style={{color: '#8B8578'}}>{mode === 'daily' ? 'Daily manpower' : 'Monthly manpower'}</p>
          <div style={{ width: '100%', height: 160 }}>
            <ResponsiveContainer>
              <BarChart data={levels}>
                <CartesianGrid strokeDasharray="3 3" stroke="#EEE8DA" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#8B8578' }} />
                <YAxis tick={{ fontSize: 10, fill: '#8B8578' }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 2, borderColor: '#D9D2C2' }} />
                <Bar dataKey="total" fill="#3D6178" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <p className="text-xs mb-1 mt-5" style={{color: '#8B8578'}}>{mode === 'daily' ? 'Day-over-day change' : 'Month-over-month change'}</p>
          <div style={{ width: '100%', height: 160 }}>
            <ResponsiveContainer>
              <BarChart data={changeData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#EEE8DA" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#8B8578' }} />
                <YAxis tick={{ fontSize: 10, fill: '#8B8578' }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 2, borderColor: '#D9D2C2' }} />
                <Bar dataKey="change" radius={[2, 2, 0, 0]}>
                  {changeData.map((entry, idx) => (
                    <Cell key={idx} fill={entry.change >= 0 ? '#4F7C52' : '#B5482F'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------- Manpower ---------------- */
function ManpowerPage({ manpower, trades, saveManpower, saveTrades, subcontractors, saveSubcontractors }) {
  const [date, setDate] = useState(todayStr());
  const [counts, setCounts] = useState({});
  const [subBreakdown, setSubBreakdown] = useState({});
  const [notes, setNotes] = useState('');
  const [newTrade, setNewTrade] = useState('');
  const [newSubcontractor, setNewSubcontractor] = useState('');
  const [expandedTrade, setExpandedTrade] = useState(null);
  const [carriedForward, setCarriedForward] = useState(false);

  useEffect(() => {
    const existing = manpower[date];
    if (existing) {
      setCounts(existing.trades || {});
      setSubBreakdown(existing.subBreakdown || {});
      setNotes(existing.notes || '');
      setCarriedForward(false);
    } else {
      // No entry yet for this date — carry forward the most recent prior day's
      // discipline/subcontractor breakdown as a starting point, so the same
      // day-to-day composition doesn't have to be re-typed every day. Notes
      // are day-specific and are never carried forward. Nothing is saved
      // until the user actually hits Save.
      const priorDates = Object.keys(manpower).filter(d => d < date).sort();
      const priorDate = priorDates[priorDates.length - 1];
      if (priorDate) {
        setCounts(manpower[priorDate].trades || {});
        setSubBreakdown(manpower[priorDate].subBreakdown || {});
        setCarriedForward(true);
      } else {
        setCounts({});
        setSubBreakdown({});
        setCarriedForward(false);
      }
      setNotes('');
    }
  }, [date, manpower]);

  // A discipline's total is manually entered UNTIL at least one subcontractor
  // row exists for it — from that point on, the total is derived from the
  // subcontractor breakdown and is no longer independently editable.
  const effectiveCount = (trade) => {
    const subs = subBreakdown[trade] || [];
    if (subs.length > 0) return subs.reduce((s, x) => s + Number(x.count || 0), 0);
    return Number(counts[trade] || 0);
  };

  const total = trades.reduce((sum, t) => sum + effectiveCount(t), 0);

  const handleSave = () => {
    const finalTrades = {};
    trades.forEach(t => { finalTrades[t] = effectiveCount(t); });
    const updated = { ...manpower, [date]: { trades: finalTrades, subBreakdown, notes, updatedAt: new Date().toISOString() } };
    saveManpower(updated);
    setCarriedForward(false);
  };

  const addTrade = () => {
    const name = newTrade.trim();
    if (!name || trades.includes(name)) return;
    saveTrades([...trades, name]);
    setNewTrade('');
  };

  const addSubcontractor = () => {
    const name = newSubcontractor.trim();
    if (!name || subcontractors.includes(name)) return;
    saveSubcontractors([...subcontractors, name]);
    setNewSubcontractor('');
  };
  const removeSubcontractor = (name) => saveSubcontractors(subcontractors.filter(s => s !== name));

  const addSubRow = (trade) => {
    setSubBreakdown(prev => ({ ...prev, [trade]: [...(prev[trade] || []), { subcontractor: '', count: '' }] }));
    setExpandedTrade(trade);
  };
  const updateSubRow = (trade, idx, field, value) => {
    setSubBreakdown(prev => {
      const list = [...(prev[trade] || [])];
      list[idx] = { ...list[idx], [field]: value };
      return { ...prev, [trade]: list };
    });
  };
  const removeSubRow = (trade, idx) => {
    setSubBreakdown(prev => {
      const list = [...(prev[trade] || [])];
      list.splice(idx, 1);
      if (list.length === 0) {
        // No subcontractor rows left — hand the last computed total back to
        // the manual field instead of reverting to whatever stale value was
        // there before the breakdown existed.
        const priorTotal = (prev[trade] || []).reduce((s, x) => s + Number(x.count || 0), 0);
        setCounts(c => ({ ...c, [trade]: priorTotal }));
      }
      return { ...prev, [trade]: list };
    });
  };

  const history = useMemo(() => {
    return Object.keys(manpower).sort().reverse().slice(0, 14).map(d => ({
      date: d,
      total: Object.values(manpower[d].trades || {}).reduce((a, b) => a + Number(b || 0), 0),
    }));
  }, [manpower]);

  return (
    <div className="space-y-5">
      <div className="tracker-card bg-white border rounded-sm p-4" style={{borderColor: '#D9D2C2'}}>
        <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs mb-1" style={{color: '#8B8578'}}>Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="border rounded-sm px-2 py-1.5 text-sm" style={{borderColor: '#D9D2C2'}}
              />
            </div>
            <div className="text-sm" style={{color: '#8B8578'}}>
              Total on site: <span className="font-semibold text-base" style={{color: '#2A2620'}}>{total}</span>
            </div>
          </div>
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 text-white px-4 py-2 rounded-sm text-sm" style={{backgroundColor: '#1C2733'}}
          >
            <Save size={14} /> Save entry
          </button>
        </div>

        {carriedForward && (
          <p className="text-xs mb-3" style={{ color: '#D98E2B' }}>
            Carried forward from the last logged day — review and adjust before saving.
          </p>
        )}

        <div className="mb-3">
          {trades.map(trade => {
            const subs = subBreakdown[trade] || [];
            const subTotal = subs.reduce((s, x) => s + Number(x.count || 0), 0);
            const expanded = expandedTrade === trade;
            const hasSubs = subs.length > 0;
            return (
              <div key={trade} className="border-b last:border-b-0" style={{ borderColor: '#EEE8DA' }}>
                <div className="flex items-center justify-between py-2 gap-2">
                  <button
                    onClick={() => setExpandedTrade(expanded ? null : trade)}
                    className="flex items-center gap-1.5 text-sm min-w-0"
                    style={{ color: '#4A453C' }}
                  >
                    {expanded ? <ChevronDown size={14} style={{ color: '#8B8578' }} /> : <ChevronRight size={14} style={{ color: '#8B8578' }} />}
                    <span className="truncate">{trade}</span>
                    {hasSubs && (
                      <span className="text-xs whitespace-nowrap" style={{ color: '#8B8578' }}>
                        ({subs.length} subcontractor{subs.length === 1 ? '' : 's'})
                      </span>
                    )}
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      type="number"
                      min="0"
                      value={hasSubs ? subTotal : (counts[trade] ?? '')}
                      placeholder="0"
                      disabled={hasSubs}
                      onChange={(e) => setCounts({ ...counts, [trade]: e.target.value })}
                      className="w-24 border rounded-sm px-2 py-1 text-right"
                      style={{ borderColor: '#D9D2C2', backgroundColor: hasSubs ? '#F1EDE4' : 'white', color: hasSubs ? '#8B8578' : '#2A2620' }}
                      title={hasSubs ? 'Auto-computed from the subcontractor breakdown below' : undefined}
                    />
                    <Trash2
                      size={14}
                      className="cursor-pointer" style={{ color: '#C4BCA8' }}
                      onClick={() => saveTrades(trades.filter(t => t !== trade))}
                    />
                  </div>
                </div>
                {expanded && (
                  <div className="pb-3 pl-5 space-y-2">
                    {hasSubs ? (
                      <p className="text-xs" style={{ color: '#8B8578' }}>
                        Discipline total is auto-computed as the sum of the subcontractor counts below ({subTotal}). Remove all subcontractor rows to enter the total manually again.
                      </p>
                    ) : (
                      <p className="text-xs" style={{ color: '#8B8578' }}>No subcontractor breakdown for this discipline yet — optional. Add one below and the discipline total will be computed from it automatically.</p>
                    )}
                    {subs.map((s, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <select
                          value={s.subcontractor}
                          onChange={(e) => updateSubRow(trade, i, 'subcontractor', e.target.value)}
                          className="flex-1 border rounded-sm px-2 py-1 text-xs bg-white" style={{ borderColor: '#D9D2C2' }}
                        >
                          <option value="">Select subcontractor</option>
                          {subcontractors.map(sc => <option key={sc} value={sc}>{sc}</option>)}
                        </select>
                        <input
                          type="number" min="0"
                          value={s.count}
                          onChange={(e) => updateSubRow(trade, i, 'count', e.target.value)}
                          className="w-20 border rounded-sm px-2 py-1 text-xs text-right" style={{ borderColor: '#D9D2C2' }}
                        />
                        <X size={12} className="cursor-pointer" style={{ color: '#8B8578' }} onClick={() => removeSubRow(trade, i)} />
                      </div>
                    ))}
                    <button
                      onClick={() => addSubRow(trade)}
                      className="flex items-center gap-1 text-xs border px-2 py-1 rounded-sm"
                      style={{ color: '#3D6178', borderColor: '#3D6178' }}
                    >
                      <Plus size={12} /> Add subcontractor
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2 mb-4">
          <input
            value={newTrade}
            onChange={(e) => setNewTrade(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTrade()}
            placeholder="Add another discipline"
            className="border rounded-sm px-2 py-1.5 text-sm flex-1 max-w-xs" style={{borderColor: '#D9D2C2'}}
          />
          <button onClick={addTrade} className="flex items-center gap-1 text-sm border rounded-sm px-2 py-1.5" style={{color: '#3D6178', borderColor: '#3D6178'}}>
            <Plus size={14} /> Add
          </button>
        </div>

        <label className="block text-xs mb-1" style={{color: '#8B8578'}}>Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Site conditions, absences, remarks..."
          className="w-full border rounded-sm px-2 py-1.5 text-sm mb-4" style={{borderColor: '#D9D2C2'}}
        />

        <button
          onClick={handleSave}
          className="flex items-center gap-1.5 text-white px-4 py-2 rounded-sm text-sm" style={{backgroundColor: '#1C2733'}}
        >
          <Save size={14} /> Save entry
        </button>
      </div>

      <div className="tracker-card bg-white border rounded-sm p-4" style={{borderColor: '#D9D2C2'}}>
        <h2 className="text-lg font-semibold mb-3" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>Subcontractors</h2>
        <p className="text-xs mb-3" style={{ color: '#8B8578' }}>
          Manage the list of subcontractors available for the breakdown above, and on Daily Log entries and sub-activities.
        </p>
        <div className="flex flex-wrap gap-2 mb-3">
          {subcontractors.length === 0 && (
            <p className="text-xs" style={{ color: '#8B8578' }}>None added yet.</p>
          )}
          {subcontractors.map(sc => (
            <span
              key={sc}
              className="flex items-center gap-1.5 text-xs border rounded-sm px-2 py-1"
              style={{ borderColor: '#D9D2C2', color: '#4A453C' }}
            >
              {sc}
              <X size={11} className="cursor-pointer" style={{ color: '#B7ADA0' }} onClick={() => removeSubcontractor(sc)} />
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            value={newSubcontractor}
            onChange={(e) => setNewSubcontractor(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addSubcontractor()}
            placeholder="Add a subcontractor"
            className="border rounded-sm px-2 py-1.5 text-sm flex-1 max-w-xs" style={{ borderColor: '#D9D2C2' }}
          />
          <button onClick={addSubcontractor} className="flex items-center gap-1 text-sm border rounded-sm px-2 py-1.5" style={{ color: '#3D6178', borderColor: '#3D6178' }}>
            <Plus size={14} /> Add
          </button>
        </div>
      </div>

      <div className="tracker-card bg-white border rounded-sm p-4" style={{borderColor: '#D9D2C2'}}>
        <h2 className="text-lg font-semibold mb-3" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>Recent entries</h2>
        {history.length === 0 ? (
          <p className="text-sm" style={{color: '#8B8578'}}>No entries logged yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs border-b" style={{color: '#8B8578', borderColor: '#D9D2C2'}}>
                <th className="py-1.5 font-normal">Date</th>
                <th className="py-1.5 font-normal text-right">Total manpower</th>
                <th className="py-1.5 font-normal text-right w-10"></th>
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h.date} className="border-b last:border-b-0 cursor-pointer" style={{ borderColor: '#EEE8DA' }} onClick={() => setDate(h.date)}>
                  <td className="py-1.5">{fmtDate(h.date)}</td>
                  <td className="py-1.5 text-right font-medium">{h.total}</td>
                  <td className="py-1.5 text-right">
                    <Trash2
                      size={14}
                      className="inline-block cursor-pointer"
                      style={{ color: '#8B8578' }}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        const updated = { ...manpower };
                        delete updated[h.date];
                        saveManpower(updated);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ---------------- Activities ---------------- */
const emptyForm = {
  name: '', category: '', area: '', priority: 'Medium',
  plannedStart: '', plannedEnd: '', actualStart: '', actualEnd: '',
  totalScope: '', balanceScope: '', unit: '',
  assignedTo: '', notes: '',
};

function ActivitiesPage({ activities, saveActivities, trades, areas, saveAreas }) {
  const [filter, setFilter] = useState('All');
  const [areaFilter, setAreaFilter] = useState('All');
  const [disciplineFilter, setDisciplineFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [importMsg, setImportMsg] = useState('');
  const [newArea, setNewArea] = useState('');
  const fileInputRef = useRef(null);

  const addArea = () => {
    const name = newArea.trim();
    if (!name || areas.includes(name)) return;
    saveAreas([...areas, name]);
    setNewArea('');
  };
  const removeArea = (name) => {
    saveAreas(areas.filter(a => a !== name));
    if (areaFilter === name) setAreaFilter('All');
  };

  const handleImportFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      // Deliberately NOT using cellDates: true. With it, SheetJS builds JS Date
      // objects using a timezone correction that is off by ~10 seconds in some
      // zones (e.g. Asia/Kolkata, due to a rounded 1899 offset), which lands
      // the date on 23:59:50 of the PREVIOUS day. Reading raw serial numbers
      // and converting them ourselves (excelSerialToDateStr) avoids timezone
      // math entirely.
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      const parsed = rows.map(rowToActivity).filter(a => a.name);
      if (parsed.length === 0) {
        setImportMsg('No valid rows found — make sure there is an "Activity" or "Task" column with names.');
      } else {
        saveActivities([...activities, ...parsed]);
        setImportMsg(`Imported ${parsed.length} activit${parsed.length === 1 ? 'y' : 'ies'} from the file.`);
      }
    } catch (err) {
      setImportMsg('Could not read that file. Use .xlsx, .xls, or .csv.');
    } finally {
      e.target.value = '';
    }
  };

  const filtered = useMemo(() => {
    let list = [...activities];
    if (filter !== 'All') {
      list = list.filter(a => scheduleCategory(a) === filter);
    }
    if (areaFilter !== 'All') {
      list = list.filter(a => (a.area || 'Unassigned') === areaFilter);
    }
    if (disciplineFilter !== 'All') {
      list = list.filter(a => (a.category || 'Unassigned') === disciplineFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(a => a.name.toLowerCase().includes(q));
    }
    return list.sort((a, b) => {
      if (!a.plannedEnd) return 1;
      if (!b.plannedEnd) return -1;
      return a.plannedEnd < b.plannedEnd ? -1 : 1;
    });
  }, [activities, filter, areaFilter, disciplineFilter, searchQuery]);

  const counts = useMemo(() => {
    const c = { All: activities.length };
    CATEGORY_LIST.forEach(cat => { c[cat] = 0; });
    activities.forEach(a => { c[scheduleCategory(a)] = (c[scheduleCategory(a)] || 0) + 1; });
    return c;
  }, [activities]);

  const resetForm = () => { setForm(emptyForm); setEditingId(null); setShowForm(false); };

  const handleSubmit = () => {
    if (!form.name.trim()) return;
    const statusOverride = form.actualEnd ? { status: 'Completed' } : {};
    if (editingId) {
      saveActivities(activities.map(a => a.id === editingId ? { ...a, ...form, ...statusOverride } : a));
    } else {
      saveActivities([...activities, { id: uid(), status: 'Pending', createdAt: new Date().toISOString(), ...form, ...statusOverride }]);
    }
    resetForm();
  };

  const startEdit = (a) => {
    setForm({
      name: a.name, category: a.category || '', area: a.area || '', priority: a.priority,
      plannedStart: a.plannedStart || '', plannedEnd: a.plannedEnd || '',
      actualStart: a.actualStart || '', actualEnd: a.actualEnd || '',
      totalScope: a.totalScope ?? '', balanceScope: a.balanceScope ?? '', unit: a.unit || '',
      assignedTo: a.assignedTo || '', notes: a.notes || '',
    });
    setEditingId(a.id);
    setShowForm(true);
  };

  const cycleStatus = (a) => {
    const idx = STATUS_ORDER.indexOf(a.status);
    const next = STATUS_ORDER[(idx + 1) % STATUS_ORDER.length];
    saveActivities(activities.map(x => x.id === a.id ? { ...x, status: next } : x));
  };

  const removeActivity = (id) => {
    saveActivities(activities.filter(a => a.id !== id));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex gap-1 overflow-x-auto">
          {['All', ...CATEGORY_LIST].map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className="px-3 py-1.5 text-xs rounded-sm whitespace-nowrap border"
              style={{
                background: filter === f ? '#1C2733' : 'white',
                color: filter === f ? 'white' : '#4A453C',
                borderColor: filter === f ? '#1C2733' : '#D9D2C2',
              }}
            >
              {f} ({counts[f] || 0})
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleImportFile}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            className="flex items-center gap-1.5 bg-white border px-3 py-1.5 rounded-sm text-sm" style={{color: '#3D6178', borderColor: '#3D6178'}}
          >
            Import from Excel
          </button>
          <button
            onClick={() => { resetForm(); setShowForm(true); }}
            className="flex items-center gap-1.5 text-white px-3 py-1.5 rounded-sm text-sm" style={{backgroundColor: '#D98E2B'}}
          >
            <Plus size={14} /> New activity
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Area</label>
          <select
            value={areaFilter}
            onChange={(e) => setAreaFilter(e.target.value)}
            className="border rounded-sm px-2 py-1.5 text-sm bg-white" style={{ borderColor: '#D9D2C2' }}
          >
            <option value="All">All areas</option>
            {areas.map(ar => <option key={ar} value={ar}>{ar}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Discipline</label>
          <select
            value={disciplineFilter}
            onChange={(e) => setDisciplineFilter(e.target.value)}
            className="border rounded-sm px-2 py-1.5 text-sm bg-white" style={{ borderColor: '#D9D2C2' }}
          >
            <option value="All">All disciplines</option>
            {trades.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="flex-1" style={{ minWidth: 160 }}>
          <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Search</label>
          <input
            list="activity-name-suggestions"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search activity description..."
            className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }}
          />
          <datalist id="activity-name-suggestions">
            {Array.from(new Set(activities.map(a => a.name))).map(n => <option key={n} value={n} />)}
          </datalist>
        </div>
        {(areaFilter !== 'All' || disciplineFilter !== 'All' || searchQuery) && (
          <button
            onClick={() => { setAreaFilter('All'); setDisciplineFilter('All'); setSearchQuery(''); }}
            className="text-xs underline" style={{ color: '#3D6178' }}
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-xs mr-1" style={{ color: '#8B8578' }}>Manage areas:</span>
        {areas.length === 0 && <span className="text-xs" style={{ color: '#8B8578' }}>None added yet.</span>}
        {areas.map(ar => (
          <span
            key={ar}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-sm border"
            style={{ borderColor: '#D9D2C2', color: '#4A453C' }}
          >
            {ar}
            <X size={11} className="cursor-pointer" style={{ color: '#B7ADA0' }} onClick={() => removeArea(ar)} />
          </span>
        ))}
        <input
          placeholder="Add area"
          value={newArea}
          onChange={(ev) => setNewArea(ev.target.value)}
          onKeyDown={(ev) => ev.key === 'Enter' && addArea()}
          className="border rounded-sm px-2 py-1 text-xs w-24" style={{ borderColor: '#D9D2C2' }}
        />
        <button onClick={addArea} className="flex items-center px-2 py-1 text-xs rounded-sm border" style={{ color: '#3D6178', borderColor: '#3D6178' }}>
          <Plus size={12} />
        </button>
      </div>

      <p className="text-xs" style={{color: '#8B8578'}}>
        Excel columns recognized: Activity, Discipline, Priority, Planned Start, Planned Finish, Assigned To, Notes (any order, header names flexible).
      </p>

      {importMsg && (
        <div className="flex items-center justify-between border rounded-sm px-3 py-2 text-xs" style={{backgroundColor: '#F1EDE4', borderColor: '#D9D2C2', color: '#4A453C'}}>
          <span>{importMsg}</span>
          <X size={13} className="cursor-pointer" style={{color: '#8B8578'}} onClick={() => setImportMsg('')} />
        </div>
      )}

      {showForm && (
        <div className="tracker-card bg-white border rounded-sm p-4 space-y-3" style={{borderColor: '#D9D2C2'}}>
          <h3 className="text-sm font-semibold" style={{color: '#4A453C'}}>{editingId ? 'Edit activity' : 'New activity'}</h3>
          <input
            placeholder="Activity name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{borderColor: '#D9D2C2'}}
          />
          <select
            value={form.area}
            onChange={(e) => setForm({ ...form, area: e.target.value })}
            className="w-full border rounded-sm px-2 py-1.5 text-sm bg-white" style={{borderColor: '#D9D2C2'}}
          >
            <option value="">Area (optional)</option>
            {areas.map(ar => <option key={ar} value={ar}>{ar}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-3">
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              className="border rounded-sm px-2 py-1.5 text-sm bg-white" style={{borderColor: '#D9D2C2'}}
            >
              <option value="">Discipline (optional)</option>
              {trades.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
              className="border rounded-sm px-2 py-1.5 text-sm bg-white" style={{borderColor: '#D9D2C2'}}
            >
              <option value="Low">Low priority</option>
              <option value="Medium">Medium priority</option>
              <option value="High">High priority</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs mb-1" style={{color: '#8B8578'}}>Planned start</label>
              <input type="date" value={form.plannedStart} onChange={(e) => setForm({ ...form, plannedStart: e.target.value })} className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{borderColor: '#D9D2C2'}} />
            </div>
            <div>
              <label className="block text-xs mb-1" style={{color: '#8B8578'}}>Planned finish</label>
              <input type="date" value={form.plannedEnd} onChange={(e) => setForm({ ...form, plannedEnd: e.target.value })} className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{borderColor: '#D9D2C2'}} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs mb-1" style={{color: '#8B8578'}}>Actual start</label>
              <input type="date" value={form.actualStart} onChange={(e) => setForm({ ...form, actualStart: e.target.value })} className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{borderColor: '#D9D2C2'}} />
            </div>
            <div>
              <label className="block text-xs mb-1" style={{color: '#8B8578'}}>Actual finish</label>
              <input type="date" value={form.actualEnd} onChange={(e) => setForm({ ...form, actualEnd: e.target.value })} className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{borderColor: '#D9D2C2'}} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs mb-1" style={{color: '#8B8578'}}>Total scope</label>
              <input type="number" min="0" placeholder="e.g. 500" value={form.totalScope} onChange={(e) => setForm({ ...form, totalScope: e.target.value })} className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{borderColor: '#D9D2C2'}} />
            </div>
            <div>
              <label className="block text-xs mb-1" style={{color: '#8B8578'}}>Balance scope</label>
              <input type="number" min="0" placeholder="e.g. 200" value={form.balanceScope} onChange={(e) => setForm({ ...form, balanceScope: e.target.value })} className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{borderColor: '#D9D2C2'}} />
            </div>
            <div>
              <label className="block text-xs mb-1" style={{color: '#8B8578'}}>Unit</label>
              <input placeholder="RM, cum, nos..." value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{borderColor: '#D9D2C2'}} />
            </div>
          </div>
          {form.totalScope !== '' && (
            <p className="text-xs" style={{color: '#8B8578'}}>
              Balance scope auto-updates from Actual Qty logged in the Daily Log for this activity — edits here get overwritten the next time a daily entry changes.
            </p>
          )}
          {form.totalScope !== '' && (
            <p className="text-xs" style={{color: '#8B8578'}}>
              Completion: <span style={{color: '#2A2620', fontWeight: 600}}>
                {percentComplete({ totalScope: form.totalScope, balanceScope: form.balanceScope }) ?? '—'}%
              </span> (based on total vs balance scope)
            </p>
          )}
          <input
            placeholder="Assigned to"
            value={form.assignedTo}
            onChange={(e) => setForm({ ...form, assignedTo: e.target.value })}
            className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{borderColor: '#D9D2C2'}}
          />
          <textarea
            placeholder="Notes"
            rows={2}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{borderColor: '#D9D2C2'}}
          />
          <div className="flex gap-2">
            <button onClick={handleSubmit} className="flex items-center gap-1.5 text-white px-3 py-1.5 rounded-sm text-sm" style={{backgroundColor: '#1C2733'}}>
              <Check size={14} /> {editingId ? 'Save changes' : 'Add activity'}
            </button>
            <button onClick={resetForm} className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-sm border" style={{color: '#4A453C', borderColor: '#D9D2C2'}}>
              <X size={14} /> Cancel
            </button>
          </div>
        </div>
      )}

      <div className="tracker-card bg-white border rounded-sm overflow-hidden" style={{borderColor: '#D9D2C2'}}>
        {filtered.length === 0 ? (
          <p className="text-sm p-4" style={{color: '#8B8578'}}>No activities in this view.</p>
        ) : (
          <ul>
            {filtered.map(a => {
              const pct = percentComplete(a);
              return (
              <li key={a.id} className="p-3 border-b last:border-b-0 flex items-start justify-between gap-3" style={{borderColor: '#EEE8DA'}}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <p className="text-sm font-medium truncate">{a.name}</p>
                    <Badge label={a.priority} color={PRIORITY_COLORS[a.priority]} />
                    {a.category && <span className="text-xs" style={{color: '#8B8578'}}>{a.category}</span>}
                    {a.area && <span className="text-xs" style={{color: '#8B8578'}}>· {a.area}</span>}
                  </div>
                  <p className="text-xs" style={{color: '#8B8578'}}>
                    Planned: {fmtDate(a.plannedStart)} → {fmtDate(a.plannedEnd)}
                    {a.assignedTo && <> · {a.assignedTo}</>}
                  </p>
                  {(a.actualStart || a.actualEnd) && (
                    <p className="text-xs" style={{color: '#8B8578'}}>
                      Actual: {fmtDate(a.actualStart)} → {fmtDate(a.actualEnd)}
                    </p>
                  )}
                  {pct !== null && (
                    <div className="flex items-center gap-2 mt-1.5 max-w-xs">
                      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{backgroundColor: '#EEE8DA'}}>
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: pct >= 100 ? '#4F7C52' : '#3D6178' }} />
                      </div>
                      <span className="text-xs whitespace-nowrap" style={{color: '#8B8578'}}>
                        {pct}% ({a.totalScope - a.balanceScope}/{a.totalScope}{a.unit ? ` ${a.unit}` : ''})
                      </span>
                    </div>
                  )}
                  {a.notes && <p className="text-xs mt-1" style={{color: '#8B8578'}}>{a.notes}</p>}
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <button onClick={() => cycleStatus(a)} title={`Workflow status: ${a.status} (click to advance)`}>
                    <Badge label={scheduleCategory(a)} color={CATEGORY_COLORS[scheduleCategory(a)]} />
                  </button>
                  <div className="flex gap-2">
                    <Pencil size={14} className="cursor-pointer" style={{color: '#8B8578'}} onClick={() => startEdit(a)} />
                    <Trash2 size={14} className="cursor-pointer" style={{color: '#8B8578'}} onClick={() => removeActivity(a.id)} />
                  </div>
                </div>
              </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ---------------- Daily Activity Tracker ---------------- */
const emptyLogForm = { date: todayStr(), activityId: '', plannedQty: '', actualQty: '', manpower: '', subcontractor: '' };

function dayTotalForDiscipline(manpower, date, discipline) {
  if (!discipline) return null;
  const entry = manpower[date];
  if (!entry) return 0;
  return Number(entry.trades?.[discipline] || 0);
}

const emptySubForm = { description: '', manpower: '', plannedQty: '', uom: '', actualQty: '', subcontractor: '' };

function DailyLogPage({ activities, manpower, dailyLog, saveDailyLog, subActivities, saveSubActivities, areas, subcontractors }) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyLogForm);
  const [expandedId, setExpandedId] = useState(null);
  const [subFormEntryId, setSubFormEntryId] = useState(null);
  const [editingSubId, setEditingSubId] = useState(null);
  const [subForm, setSubForm] = useState(emptySubForm);
  const [areaFilter, setAreaFilter] = useState('All');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const activityById = useMemo(() => Object.fromEntries(activities.map(a => [a.id, a])), [activities]);
  const selectedActivity = activityById[form.activityId];
  const discipline = selectedActivity?.category || '';

  const disciplineTotal = dayTotalForDiscipline(manpower, form.date, discipline);
  const alreadyEngaged = useMemo(() => {
    return dailyLog
      .filter(e => e.id !== editingId && e.date === form.date && activityById[e.activityId]?.category === discipline)
      .reduce((sum, e) => sum + Number(e.manpower || 0), 0);
  }, [dailyLog, editingId, form.date, discipline, activityById]);
  const remaining = disciplineTotal === null ? null : Math.max(0, disciplineTotal - alreadyEngaged);
  const exceedsManpower = remaining !== null && Number(form.manpower || 0) > remaining;

  const resetForm = () => { setForm(emptyLogForm); setEditingId(null); setShowForm(false); };

  const handleSubmit = () => {
    if (!form.activityId || exceedsManpower) return;
    if (editingId) {
      saveDailyLog(dailyLog.map(e => e.id === editingId ? { ...e, ...form } : e));
    } else {
      saveDailyLog([...dailyLog, { id: uid(), createdAt: new Date().toISOString(), ...form }]);
    }
    resetForm();
  };

  const startEdit = (e) => {
    setForm({ date: e.date, activityId: e.activityId, plannedQty: e.plannedQty ?? '', actualQty: e.actualQty ?? '', manpower: e.manpower ?? '', subcontractor: e.subcontractor || '' });
    setEditingId(e.id);
    setShowForm(true);
  };

  const removeEntry = (id) => {
    saveDailyLog(dailyLog.filter(e => e.id !== id));
    saveSubActivities(subActivities.filter(s => s.entryId !== id));
  };

  const sorted = useMemo(() => {
    let list = [...dailyLog];
    if (areaFilter !== 'All') {
      list = list.filter(e => (activityById[e.activityId]?.area || 'Unassigned') === areaFilter);
    }
    if (dateFrom) list = list.filter(e => e.date >= dateFrom);
    if (dateTo) list = list.filter(e => e.date <= dateTo);
    return list.sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [dailyLog, areaFilter, dateFrom, dateTo, activityById]);

  const resetSubForm = () => { setSubForm(emptySubForm); setEditingSubId(null); setSubFormEntryId(null); };
  const subUsedFor = (entryId, excludeId) => subActivities
    .filter(s => s.entryId === entryId && s.id !== excludeId)
    .reduce((sum, s) => sum + Number(s.manpower || 0), 0);
  const submitSub = (entry) => {
    const entryManpower = Number(entry.manpower || 0);
    const used = subUsedFor(entry.id, editingSubId);
    const exceedsSub = used + Number(subForm.manpower || 0) > entryManpower;
    if (!subForm.description.trim() || exceedsSub) return;
    if (editingSubId) {
      saveSubActivities(subActivities.map(s => s.id === editingSubId ? { ...s, ...subForm } : s));
    } else {
      saveSubActivities([...subActivities, { id: uid(), entryId: entry.id, createdAt: new Date().toISOString(), ...subForm }]);
    }
    resetSubForm();
  };
  const startEditSub = (s) => {
    setSubForm({
      description: s.description || '', manpower: s.manpower ?? '',
      plannedQty: s.plannedQty ?? '', uom: s.uom || '', actualQty: s.actualQty ?? '',
      subcontractor: s.subcontractor || '',
    });
    setEditingSubId(s.id);
    setSubFormEntryId(s.entryId);
  };
  const removeSub = (id) => saveSubActivities(subActivities.filter(s => s.id !== id));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>Daily activity tracker</h2>
        <button
          onClick={() => { resetForm(); setShowForm(true); }}
          className="flex items-center gap-1.5 text-white px-3 py-1.5 rounded-sm text-sm"
          style={{ backgroundColor: '#D98E2B' }}
        >
          <Plus size={14} /> Add entry
        </button>
      </div>

      {areas.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs mr-1" style={{ color: '#8B8578' }}>Area:</span>
          {['All', ...areas].map(ar => (
            <button
              key={ar}
              onClick={() => setAreaFilter(ar)}
              className="px-2.5 py-1 text-xs rounded-sm whitespace-nowrap border"
              style={{
                background: areaFilter === ar ? '#3D6178' : 'white',
                color: areaFilter === ar ? 'white' : '#4A453C',
                borderColor: areaFilter === ar ? '#3D6178' : '#D9D2C2',
              }}
            >
              {ar}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs" style={{ color: '#8B8578' }}>Date:</span>
        <input
          type="date" value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="border rounded-sm px-2 py-1 text-xs" style={{ borderColor: '#D9D2C2' }}
        />
        <span className="text-xs" style={{ color: '#8B8578' }}>to</span>
        <input
          type="date" value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="border rounded-sm px-2 py-1 text-xs" style={{ borderColor: '#D9D2C2' }}
        />
        {(dateFrom || dateTo) && (
          <button
            onClick={() => { setDateFrom(''); setDateTo(''); }}
            className="text-xs underline"
            style={{ color: '#3D6178' }}
          >
            Clear
          </button>
        )}
      </div>

      {activities.length === 0 && (
        <p className="text-sm" style={{ color: '#8B8578' }}>Add activities in the Activities tab first, then log daily progress against them here.</p>
      )}

      {showForm && (
        <div className="tracker-card bg-white border rounded-sm p-4 space-y-3" style={{ borderColor: '#D9D2C2' }}>
          <h3 className="text-sm font-semibold" style={{ color: '#4A453C' }}>{editingId ? 'Edit entry' : 'New daily entry'}</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Date</label>
              <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }} />
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Activity</label>
              <select
                value={form.activityId}
                onChange={(e) => setForm({ ...form, activityId: e.target.value })}
                className="w-full border rounded-sm px-2 py-1.5 text-sm bg-white"
                style={{ borderColor: '#D9D2C2' }}
              >
                <option value="">Select activity</option>
                {activities.map(a => (
                  <option key={a.id} value={a.id}>{a.name}{a.category ? ` (${a.category})` : ''}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Planned qty for the day</label>
              <input type="number" min="0" value={form.plannedQty} onChange={(e) => setForm({ ...form, plannedQty: e.target.value })} className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }} />
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Actual qty for the day</label>
              <input type="number" min="0" value={form.actualQty} onChange={(e) => setForm({ ...form, actualQty: e.target.value })} className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }} />
            </div>
          </div>

          <div>
            <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Manpower engaged</label>
            <input
              type="number" min="0"
              value={form.manpower}
              onChange={(e) => setForm({ ...form, manpower: e.target.value })}
              className="w-full border rounded-sm px-2 py-1.5 text-sm"
              style={{ borderColor: exceedsManpower ? '#B5482F' : '#D9D2C2' }}
            />
            {discipline ? (
              <p className="text-xs mt-1" style={{ color: exceedsManpower ? '#B5482F' : '#8B8578' }}>
                {remaining} of {disciplineTotal} {discipline} workers available on {fmtDate(form.date)}
                {exceedsManpower && ' — exceeds available manpower for this discipline that day.'}
              </p>
            ) : form.activityId ? (
              <p className="text-xs mt-1" style={{ color: '#8B8578' }}>This activity has no discipline set, so manpower isn't checked against the Manpower tab.</p>
            ) : null}
          </div>

          <div>
            <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Subcontractor (optional)</label>
            <select
              value={form.subcontractor}
              onChange={(e) => setForm({ ...form, subcontractor: e.target.value })}
              className="w-full border rounded-sm px-2 py-1.5 text-sm bg-white" style={{ borderColor: '#D9D2C2' }}
            >
              <option value="">Not specified</option>
              {subcontractors.map(sc => <option key={sc} value={sc}>{sc}</option>)}
            </select>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSubmit}
              disabled={!form.activityId || exceedsManpower}
              className="flex items-center gap-1.5 text-white px-3 py-1.5 rounded-sm text-sm"
              style={{ backgroundColor: (!form.activityId || exceedsManpower) ? '#B7ADA0' : '#1C2733' }}
            >
              <Check size={14} /> {editingId ? 'Save changes' : 'Add entry'}
            </button>
            <button onClick={resetForm} className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-sm border" style={{ color: '#4A453C', borderColor: '#D9D2C2' }}>
              <X size={14} /> Cancel
            </button>
          </div>
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="tracker-card bg-white border rounded-sm p-4" style={{ borderColor: '#D9D2C2' }}>
          <p className="text-sm" style={{ color: '#8B8578' }}>No daily entries logged yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map(e => {
            const act = activityById[e.activityId];
            const variance = Number(e.actualQty || 0) - Number(e.plannedQty || 0);
            const entryManpower = Number(e.manpower || 0);
            const entrySubs = subActivities.filter(s => s.entryId === e.id);
            const subTotal = entrySubs.reduce((sum, s) => sum + Number(s.manpower || 0), 0);
            const expanded = expandedId === e.id;
            const used = subUsedFor(e.id, editingSubId);
            const subRemaining = Math.max(0, entryManpower - used);
            const exceedsSub = Number(subForm.manpower || 0) > subRemaining;
            return (
              <div key={e.id} className="tracker-card bg-white border rounded-sm overflow-hidden" style={{ borderColor: '#D9D2C2' }}>
                <div className="flex items-center justify-between p-3 cursor-pointer" onClick={() => setExpandedId(expanded ? null : e.id)}>
                  <div className="flex items-center gap-2 min-w-0">
                    {expanded ? <ChevronDown size={16} style={{ color: '#8B8578' }} /> : <ChevronRight size={16} style={{ color: '#8B8578' }} />}
                    <div className="min-w-0">
                      <p className="text-sm truncate">
                        {act ? act.name : <span style={{ color: '#B5482F' }}>Deleted activity</span>}
                        {act?.category && <span className="text-xs ml-1" style={{ color: '#8B8578' }}>({act.category})</span>}
                        {act?.area && <span className="text-xs ml-1" style={{ color: '#8B8578' }}>· {act.area}</span>}
                      </p>
                      <p className="text-xs" style={{ color: '#8B8578' }}>
                        {fmtDate(e.date)} · Planned {e.plannedQty || 0} · Actual {e.actualQty || 0}
                        <span style={{ color: variance >= 0 ? '#4F7C52' : '#B5482F' }}> ({variance > 0 ? '+' : ''}{variance})</span>
                        {' · '}Manpower {entryManpower}
                        {e.subcontractor && <> · {e.subcontractor}</>}
                        {entrySubs.length > 0 && <> · Sub-activities: {subTotal}/{entryManpower}</>}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0" onClick={(ev) => ev.stopPropagation()}>
                    <Pencil size={14} className="cursor-pointer" style={{ color: '#8B8578' }} onClick={() => startEdit(e)} />
                    <Trash2 size={14} className="cursor-pointer" style={{ color: '#8B8578' }} onClick={() => removeEntry(e.id)} />
                  </div>
                </div>

                {expanded && (
                  <div className="border-t p-3 space-y-2" style={{ borderColor: '#D9D2C2', backgroundColor: '#FAF8F2' }}>
                    <p className="text-xs font-semibold" style={{ color: '#4A453C' }}>Sub-activities</p>
                    {entrySubs.length === 0 && subFormEntryId !== e.id && (
                      <p className="text-xs" style={{ color: '#8B8578' }}>No sub-activities logged yet.</p>
                    )}
                    {entrySubs.map(s => (
                      <div key={s.id} className="flex items-start justify-between gap-2 bg-white border rounded-sm p-2" style={{ borderColor: '#EEE8DA' }}>
                        <div className="min-w-0">
                          <p className="text-xs">{s.description}</p>
                          <p className="text-xs" style={{ color: '#8B8578' }}>
                            Manpower: {s.manpower || 0}{s.subcontractor && <> · {s.subcontractor}</>}
                          </p>
                          {(s.plannedQty !== '' && s.plannedQty != null) || (s.actualQty !== '' && s.actualQty != null) ? (
                            <p className="text-xs" style={{ color: '#8B8578' }}>
                              Qty: {s.plannedQty || 0} planned · {s.actualQty || 0} actual{s.uom ? ` (${s.uom})` : ''}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <Pencil size={12} className="cursor-pointer" style={{ color: '#8B8578' }} onClick={() => startEditSub(s)} />
                          <Trash2 size={12} className="cursor-pointer" style={{ color: '#8B8578' }} onClick={() => removeSub(s.id)} />
                        </div>
                      </div>
                    ))}

                    {subFormEntryId === e.id ? (
                      <div className="p-2 rounded-sm border space-y-2" style={{ borderColor: '#3D6178' }}>
                        <input
                          placeholder="Description"
                          value={subForm.description}
                          onChange={(ev) => setSubForm({ ...subForm, description: ev.target.value })}
                          className="w-full border rounded-sm px-2 py-1.5 text-xs" style={{ borderColor: '#D9D2C2' }}
                        />
                        <div>
                          <input
                            type="number" min="0"
                            placeholder="Manpower engaged"
                            value={subForm.manpower}
                            onChange={(ev) => setSubForm({ ...subForm, manpower: ev.target.value })}
                            className="w-full border rounded-sm px-2 py-1.5 text-xs"
                            style={{ borderColor: exceedsSub ? '#B5482F' : '#D9D2C2' }}
                          />
                          <p className="text-xs mt-1" style={{ color: exceedsSub ? '#B5482F' : '#8B8578' }}>
                            {subRemaining} of {entryManpower} manpower still unassigned for this entry
                            {exceedsSub && ' — exceeds manpower engaged on this daily entry.'}
                          </p>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <input
                            type="number" min="0"
                            placeholder="Planned qty"
                            value={subForm.plannedQty}
                            onChange={(ev) => setSubForm({ ...subForm, plannedQty: ev.target.value })}
                            className="border rounded-sm px-2 py-1.5 text-xs" style={{ borderColor: '#D9D2C2' }}
                          />
                          <input
                            placeholder="UOM"
                            value={subForm.uom}
                            onChange={(ev) => setSubForm({ ...subForm, uom: ev.target.value })}
                            className="border rounded-sm px-2 py-1.5 text-xs" style={{ borderColor: '#D9D2C2' }}
                          />
                          <input
                            type="number" min="0"
                            placeholder="Actual qty"
                            value={subForm.actualQty}
                            onChange={(ev) => setSubForm({ ...subForm, actualQty: ev.target.value })}
                            className="border rounded-sm px-2 py-1.5 text-xs" style={{ borderColor: '#D9D2C2' }}
                          />
                        </div>
                        <p className="text-xs" style={{ color: '#8B8578' }}>
                          Qty and UOM here are just for tracking this sub-activity — independent of the parent activity's own quantities/unit.
                        </p>
                        <select
                          value={subForm.subcontractor}
                          onChange={(ev) => setSubForm({ ...subForm, subcontractor: ev.target.value })}
                          className="w-full border rounded-sm px-2 py-1.5 text-xs bg-white" style={{ borderColor: '#D9D2C2' }}
                        >
                          <option value="">Subcontractor (optional)</option>
                          {subcontractors.map(sc => <option key={sc} value={sc}>{sc}</option>)}
                        </select>
                        <div className="flex gap-2">
                          <button
                            onClick={() => submitSub(e)}
                            disabled={!subForm.description.trim() || exceedsSub}
                            className="flex items-center gap-1 text-white px-2 py-1 rounded-sm text-xs"
                            style={{ backgroundColor: (!subForm.description.trim() || exceedsSub) ? '#B7ADA0' : '#1C2733' }}
                          >
                            <Check size={12} /> {editingSubId ? 'Save' : 'Add'}
                          </button>
                          <button onClick={resetSubForm} className="flex items-center gap-1 px-2 py-1 rounded-sm text-xs border" style={{ color: '#4A453C', borderColor: '#D9D2C2' }}>
                            <X size={12} /> Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => { resetSubForm(); setSubFormEntryId(e.id); }}
                        className="flex items-center gap-1 text-xs border px-2 py-1 rounded-sm"
                        style={{ color: '#3D6178', borderColor: '#3D6178' }}
                        disabled={entryManpower <= 0}
                      >
                        <Plus size={12} /> Add sub-activity
                      </button>
                    )}
                    {entryManpower <= 0 && subFormEntryId !== e.id && (
                      <p className="text-xs" style={{ color: '#8B8578' }}>Set a manpower value on this entry before adding sub-activities.</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------------- Procurement ---------------- */
const PROC_STAGES = [
  { key: 'order', label: 'Order placement', exp: 'expOrder', act: 'actOrder' },
  { key: 'inspection', label: 'Inspection', exp: 'expInspection', act: 'actInspection' },
  { key: 'dispatch', label: 'Dispatch', exp: 'expDispatch', act: 'actDispatch' },
  { key: 'delivery', label: 'Delivery', exp: 'expDelivery', act: 'actDelivery' },
];
const STAGE_COLORS = { order: '#3D6178', inspection: '#8672A8', dispatch: '#D98E2B', delivery: '#4F7C52' };

const emptyItemForm = { name: '', discipline: '', supplier: '' };
const emptyLotForm = {
  lotNo: '', quantity: '', supplierLocation: '',
  expOrder: '', actOrder: '', expInspection: '', actInspection: '',
  expDispatch: '', actDispatch: '', expDelivery: '', actDelivery: '',
};
const emptyUpdateForm = { date: todayStr(), description: '' };

function lotStatus(lot) {
  const today = todayStr();
  let anyDelay = false;
  PROC_STAGES.forEach(s => {
    if (lot[s.act] && lot[s.exp] && lot[s.act] > lot[s.exp]) anyDelay = true;
  });
  const current = PROC_STAGES.find(s => !lot[s.act]);
  if (!current) {
    return { label: anyDelay ? 'Delivered (delayed)' : 'Delivered', color: anyDelay ? '#C98A3D' : '#4F7C52' };
  }
  const overdueNow = lot[current.exp] && lot[current.exp] < today;
  if (overdueNow) return { label: `${current.label} overdue`, color: '#B5482F' };
  return { label: `Awaiting ${current.label.toLowerCase()}`, color: anyDelay ? '#C98A3D' : '#3D6178' };
}

function ProcurementPage({ trades, items, saveItems, lots, saveLots, updates, saveUpdates }) {
  const [showItemForm, setShowItemForm] = useState(false);
  const [editingItemId, setEditingItemId] = useState(null);
  const [itemForm, setItemForm] = useState(emptyItemForm);
  const [expandedId, setExpandedId] = useState(null);
  const [lotFormItemId, setLotFormItemId] = useState(null);
  const [editingLotId, setEditingLotId] = useState(null);
  const [lotForm, setLotForm] = useState(emptyLotForm);
  const [updateFormLotId, setUpdateFormLotId] = useState(null);
  const [editingUpdateId, setEditingUpdateId] = useState(null);
  const [updateForm, setUpdateForm] = useState(emptyUpdateForm);

  const resetItemForm = () => { setItemForm(emptyItemForm); setEditingItemId(null); setShowItemForm(false); };
  const submitItem = () => {
    if (!itemForm.name.trim()) return;
    if (editingItemId) {
      saveItems(items.map(i => i.id === editingItemId ? { ...i, ...itemForm } : i));
    } else {
      const newItem = { id: uid(), createdAt: new Date().toISOString(), ...itemForm };
      saveItems([...items, newItem]);
      setExpandedId(newItem.id);
    }
    resetItemForm();
  };
  const startEditItem = (i) => {
    setItemForm({ name: i.name, discipline: i.discipline || '', supplier: i.supplier || '' });
    setEditingItemId(i.id);
    setShowItemForm(true);
  };
  const removeItem = (id) => {
    saveItems(items.filter(i => i.id !== id));
    saveLots(lots.filter(l => l.itemId !== id));
  };

  const resetLotForm = () => { setLotForm(emptyLotForm); setEditingLotId(null); setLotFormItemId(null); };
  const submitLot = () => {
    if (!lotForm.lotNo.trim() || !lotFormItemId) return;
    if (editingLotId) {
      saveLots(lots.map(l => l.id === editingLotId ? { ...l, ...lotForm } : l));
    } else {
      saveLots([...lots, { id: uid(), itemId: lotFormItemId, createdAt: new Date().toISOString(), ...lotForm }]);
    }
    resetLotForm();
  };
  const startEditLot = (l) => {
    setLotForm({
      lotNo: l.lotNo || '', quantity: l.quantity ?? '', supplierLocation: l.supplierLocation || '',
      expOrder: l.expOrder || '', actOrder: l.actOrder || '',
      expInspection: l.expInspection || '', actInspection: l.actInspection || '',
      expDispatch: l.expDispatch || '', actDispatch: l.actDispatch || '',
      expDelivery: l.expDelivery || '', actDelivery: l.actDelivery || '',
    });
    setEditingLotId(l.id);
    setLotFormItemId(l.itemId);
  };
  const removeLot = (id) => {
    saveLots(lots.filter(l => l.id !== id));
    saveUpdates(updates.filter(u => u.lotId !== id));
  };

  const resetUpdateForm = () => { setUpdateForm(emptyUpdateForm); setEditingUpdateId(null); setUpdateFormLotId(null); };
  const submitUpdate = () => {
    if (!updateForm.description.trim() || !updateFormLotId) return;
    if (editingUpdateId) {
      saveUpdates(updates.map(u => u.id === editingUpdateId ? { ...u, ...updateForm } : u));
    } else {
      saveUpdates([...updates, { id: uid(), lotId: updateFormLotId, createdAt: new Date().toISOString(), ...updateForm }]);
    }
    resetUpdateForm();
  };
  const startEditUpdate = (u) => {
    setUpdateForm({ date: u.date || todayStr(), description: u.description || '' });
    setEditingUpdateId(u.id);
    setUpdateFormLotId(u.lotId);
  };
  const removeUpdate = (id) => saveUpdates(updates.filter(u => u.id !== id));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>Procurement tracker</h2>
        <button
          onClick={() => { resetItemForm(); setShowItemForm(true); }}
          className="flex items-center gap-1.5 text-white px-3 py-1.5 rounded-sm text-sm"
          style={{ backgroundColor: '#D98E2B' }}
        >
          <Plus size={14} /> Add item
        </button>
      </div>

      {showItemForm && (
        <div className="tracker-card bg-white border rounded-sm p-4 space-y-3" style={{ borderColor: '#D9D2C2' }}>
          <h3 className="text-sm font-semibold" style={{ color: '#4A453C' }}>{editingItemId ? 'Edit item' : 'New procurement item'}</h3>
          <input
            placeholder="Item name"
            value={itemForm.name}
            onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })}
            className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }}
          />
          <div className="grid grid-cols-2 gap-3">
            <select
              value={itemForm.discipline}
              onChange={(e) => setItemForm({ ...itemForm, discipline: e.target.value })}
              className="border rounded-sm px-2 py-1.5 text-sm bg-white" style={{ borderColor: '#D9D2C2' }}
            >
              <option value="">Discipline (optional)</option>
              {trades.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input
              placeholder="Supplier"
              value={itemForm.supplier}
              onChange={(e) => setItemForm({ ...itemForm, supplier: e.target.value })}
              className="border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }}
            />
          </div>
          <div className="flex gap-2">
            <button onClick={submitItem} className="flex items-center gap-1.5 text-white px-3 py-1.5 rounded-sm text-sm" style={{ backgroundColor: '#1C2733' }}>
              <Check size={14} /> {editingItemId ? 'Save changes' : 'Add item'}
            </button>
            <button onClick={resetItemForm} className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-sm border" style={{ color: '#4A453C', borderColor: '#D9D2C2' }}>
              <X size={14} /> Cancel
            </button>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div className="tracker-card bg-white border rounded-sm p-4" style={{ borderColor: '#D9D2C2' }}>
          <p className="text-sm" style={{ color: '#8B8578' }}>No procurement items yet. Add one to start tracking lots against it.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(item => {
            const itemLots = lots.filter(l => l.itemId === item.id);
            const expanded = expandedId === item.id;
            return (
              <div key={item.id} className="tracker-card bg-white border rounded-sm overflow-hidden" style={{ borderColor: '#D9D2C2' }}>
                <div
                  className="flex items-center justify-between p-3 cursor-pointer"
                  onClick={() => setExpandedId(expanded ? null : item.id)}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {expanded ? <ChevronDown size={16} style={{ color: '#8B8578' }} /> : <ChevronRight size={16} style={{ color: '#8B8578' }} />}
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{item.name}</p>
                      <p className="text-xs" style={{ color: '#8B8578' }}>
                        {item.discipline && <>{item.discipline} · </>}
                        {item.supplier || 'No supplier set'} · {itemLots.length} lot{itemLots.length === 1 ? '' : 's'}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <Pencil size={14} className="cursor-pointer" style={{ color: '#8B8578' }} onClick={() => startEditItem(item)} />
                    <Trash2 size={14} className="cursor-pointer" style={{ color: '#8B8578' }} onClick={() => removeItem(item.id)} />
                  </div>
                </div>

                {expanded && (
                  <div className="border-t p-3 space-y-3" style={{ borderColor: '#D9D2C2', backgroundColor: '#FAF8F2' }}>
                    {itemLots.length === 0 && (
                      <p className="text-xs" style={{ color: '#8B8578' }}>No lots added for this item yet.</p>
                    )}
                    {itemLots.map(lot => {
                      const status = lotStatus(lot);
                      return (
                        <div key={lot.id} className="tracker-card bg-white border rounded-sm p-3" style={{ borderColor: '#D9D2C2' }}>
                          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium">Lot {lot.lotNo}</span>
                              {lot.quantity !== '' && lot.quantity != null && (
                                <span className="text-xs" style={{ color: '#8B8578' }}>Qty: {lot.quantity}</span>
                              )}
                              <Badge label={status.label} color={status.color} />
                            </div>
                            <div className="flex gap-2">
                              <Pencil size={13} className="cursor-pointer" style={{ color: '#8B8578' }} onClick={() => { setLotFormItemId(item.id); startEditLot(lot); }} />
                              <Trash2 size={13} className="cursor-pointer" style={{ color: '#8B8578' }} onClick={() => removeLot(lot.id)} />
                            </div>
                          </div>
                          {lot.supplierLocation && (
                            <p className="text-xs mb-2" style={{ color: '#8B8578' }}>Supplier location: {lot.supplierLocation}</p>
                          )}
                          <div className="grid grid-cols-2 gap-2">
                            {PROC_STAGES.map(s => (
                              <div key={s.key} className="text-xs">
                                <span style={{ color: '#8B8578' }}>{s.label}: </span>
                                <span>{fmtDate(lot[s.exp])} → </span>
                                <span style={{ color: lot[s.act] && lot[s.exp] && lot[s.act] > lot[s.exp] ? '#B5482F' : '#2A2620', fontWeight: 500 }}>
                                  {lot[s.act] ? fmtDate(lot[s.act]) : 'pending'}
                                </span>
                              </div>
                            ))}
                          </div>

                          <div className="mt-3 pt-3 border-t" style={{ borderColor: '#EEE8DA' }}>
                            <p className="text-xs font-semibold mb-2" style={{ color: '#4A453C' }}>Updates</p>
                            {updates.filter(u => u.lotId === lot.id).length === 0 && updateFormLotId !== lot.id && (
                              <p className="text-xs mb-2" style={{ color: '#8B8578' }}>No updates logged yet.</p>
                            )}
                            {updates
                              .filter(u => u.lotId === lot.id)
                              .sort((x, y) => (x.date < y.date ? 1 : -1))
                              .map(u => (
                                <div key={u.id} className="flex items-start justify-between gap-2 py-1.5 border-b last:border-b-0" style={{ borderColor: '#EEE8DA' }}>
                                  <div className="min-w-0">
                                    <p className="text-xs" style={{ color: '#8B8578' }}>{fmtDate(u.date)}</p>
                                    <p className="text-xs" style={{ color: '#2A2620' }}>{u.description}</p>
                                  </div>
                                  <div className="flex gap-2 shrink-0">
                                    <Pencil size={12} className="cursor-pointer" style={{ color: '#8B8578' }} onClick={() => startEditUpdate(u)} />
                                    <Trash2 size={12} className="cursor-pointer" style={{ color: '#8B8578' }} onClick={() => removeUpdate(u.id)} />
                                  </div>
                                </div>
                              ))}

                            {updateFormLotId === lot.id ? (
                              <div className="mt-2 space-y-2 p-2 rounded-sm border" style={{ borderColor: '#3D6178' }}>
                                <div>
                                  <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Date of update</label>
                                  <input
                                    type="date"
                                    value={updateForm.date}
                                    onChange={(e) => setUpdateForm({ ...updateForm, date: e.target.value })}
                                    className="w-full border rounded-sm px-2 py-1 text-xs" style={{ borderColor: '#D9D2C2' }}
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Description</label>
                                  <textarea
                                    rows={2}
                                    value={updateForm.description}
                                    onChange={(e) => setUpdateForm({ ...updateForm, description: e.target.value })}
                                    className="w-full border rounded-sm px-2 py-1 text-xs" style={{ borderColor: '#D9D2C2' }}
                                  />
                                </div>
                                <div className="flex gap-2">
                                  <button onClick={submitUpdate} className="flex items-center gap-1 text-white px-2 py-1 rounded-sm text-xs" style={{ backgroundColor: '#1C2733' }}>
                                    <Check size={12} /> {editingUpdateId ? 'Save' : 'Add'}
                                  </button>
                                  <button onClick={resetUpdateForm} className="flex items-center gap-1 px-2 py-1 rounded-sm text-xs border" style={{ color: '#4A453C', borderColor: '#D9D2C2' }}>
                                    <X size={12} /> Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <button
                                onClick={() => { resetUpdateForm(); setUpdateFormLotId(lot.id); }}
                                className="flex items-center gap-1 text-xs border px-2 py-1 rounded-sm mt-1"
                                style={{ color: '#3D6178', borderColor: '#3D6178' }}
                              >
                                <Plus size={12} /> Add update
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {lotFormItemId === item.id ? (
                      <div className="tracker-card bg-white border rounded-sm p-3 space-y-3" style={{ borderColor: '#3D6178' }}>
                        <h4 className="text-xs font-semibold" style={{ color: '#4A453C' }}>{editingLotId ? 'Edit lot' : 'New lot'}</h4>
                        <div className="grid grid-cols-3 gap-3">
                          <input
                            placeholder="Lot no."
                            value={lotForm.lotNo}
                            onChange={(e) => setLotForm({ ...lotForm, lotNo: e.target.value })}
                            className="border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }}
                          />
                          <input
                            type="number" min="0"
                            placeholder="Quantity"
                            value={lotForm.quantity}
                            onChange={(e) => setLotForm({ ...lotForm, quantity: e.target.value })}
                            className="border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }}
                          />
                          <input
                            placeholder="Supplier location"
                            value={lotForm.supplierLocation}
                            onChange={(e) => setLotForm({ ...lotForm, supplierLocation: e.target.value })}
                            className="border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }}
                          />
                        </div>
                        {PROC_STAGES.map(s => (
                          <div key={s.key} className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Expected {s.label.toLowerCase()}</label>
                              <input
                                type="date"
                                value={lotForm[s.exp]}
                                onChange={(e) => setLotForm({ ...lotForm, [s.exp]: e.target.value })}
                                className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }}
                              />
                            </div>
                            <div>
                              <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Actual {s.label.toLowerCase()}</label>
                              <input
                                type="date"
                                value={lotForm[s.act]}
                                onChange={(e) => setLotForm({ ...lotForm, [s.act]: e.target.value })}
                                className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }}
                              />
                            </div>
                          </div>
                        ))}
                        <div className="flex gap-2">
                          <button onClick={submitLot} className="flex items-center gap-1.5 text-white px-3 py-1.5 rounded-sm text-sm" style={{ backgroundColor: '#1C2733' }}>
                            <Check size={14} /> {editingLotId ? 'Save changes' : 'Add lot'}
                          </button>
                          <button onClick={resetLotForm} className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-sm border" style={{ color: '#4A453C', borderColor: '#D9D2C2' }}>
                            <X size={14} /> Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => { resetLotForm(); setLotFormItemId(item.id); }}
                        className="flex items-center gap-1.5 text-sm border px-3 py-1.5 rounded-sm"
                        style={{ color: '#3D6178', borderColor: '#3D6178' }}
                      >
                        <Plus size={14} /> Add lot
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------------- MOM / Record Notes ---------------- */
const MOM_MAX_CHARS = 4_800_000; // safety margin under the 5MB per-key storage cap

function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
function dataUriToArrayBuffer(dataUri) {
  const base64 = dataUri.split(',')[1] || '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
function fmtKB(kb) {
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${kb} KB`;
}
function momFileType(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.doc')) return 'doc';
  return 'other';
}

function MOMPreviewBody({ entry, fileName }) {
  if (!entry || entry.status === 'loading') {
    return <div className="flex items-center justify-center py-10"><Loader2 size={18} className="animate-spin" style={{ color: '#3D6178' }} /></div>;
  }
  if (entry.status === 'error') {
    return <p className="text-xs p-3" style={{ color: '#B5482F' }}>Couldn't load this file.</p>;
  }
  if (entry.status === 'unsupported' || entry.type === 'doc') {
    return (
      <div className="p-3 space-y-2">
        <p className="text-xs" style={{ color: '#8B8578' }}>
          Legacy .doc files can't be previewed in-browser — only .pdf and .docx are supported. You can still download it below.
        </p>
        {entry.dataUri && <a href={entry.dataUri} download={fileName} className="text-xs underline" style={{ color: '#3D6178' }}>Download {fileName}</a>}
      </div>
    );
  }
  if (entry.type === 'pdf') {
    return (
      <div>
        <iframe src={entry.dataUri} title={fileName} style={{ width: '100%', height: 480, border: '1px solid #D9D2C2' }} />
        <a href={entry.dataUri} download={fileName} className="text-xs underline block mt-2" style={{ color: '#3D6178' }}>Download {fileName}</a>
      </div>
    );
  }
  if (entry.type === 'docx') {
    return (
      <div>
        <div
          className="text-xs p-3 rounded-sm border"
          style={{ maxHeight: 480, overflow: 'auto', borderColor: '#D9D2C2', backgroundColor: 'white' }}
          dangerouslySetInnerHTML={{ __html: entry.html }}
        />
        <a href={entry.dataUri} download={fileName} className="text-xs underline block mt-2" style={{ color: '#3D6178' }}>Download {fileName}</a>
      </div>
    );
  }
  return null;
}

function MOMPage({ records, saveRecords, projectId }) {
  const [showForm, setShowForm] = useState(false);
  const [description, setDescription] = useState('');
  const [meetingDate, setMeetingDate] = useState(todayStr());
  const [pendingFile, setPendingFile] = useState(null);
  const [fileError, setFileError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [compareSelected, setCompareSelected] = useState([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [previewCache, setPreviewCache] = useState({});
  const fileInputRef = useRef(null);

  const resetForm = () => {
    setDescription(''); setMeetingDate(todayStr()); setPendingFile(null); setFileError('');
    setShowForm(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileChange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setFileError('');
    const type = momFileType(file.name);
    if (type !== 'pdf' && type !== 'docx' && type !== 'doc') {
      setFileError('Only .pdf, .docx, or .doc files are supported.');
      setPendingFile(null);
      return;
    }
    try {
      const dataUri = await fileToDataUri(file);
      if (dataUri.length > MOM_MAX_CHARS) {
        setFileError(`This file is too large to store (~${fmtKB(Math.round(file.size / 1024))}). Keep files under roughly 3.5 MB.`);
        setPendingFile(null);
        return;
      }
      setPendingFile({ fileName: file.name, fileType: type, dataUri, sizeKB: Math.round(file.size / 1024) });
    } catch (err) {
      setFileError('Could not read that file.');
    }
  };

  const loadPreview = async (record) => {
    setPreviewCache(prev => ({ ...prev, [record.id]: { status: 'loading' } }));
    try {
      const stored = await safeGet(`mom-file:${projectId}:${record.id}`, true);
      if (!stored) throw new Error('missing');
      if (record.fileType === 'pdf') {
        setPreviewCache(prev => ({ ...prev, [record.id]: { status: 'ready', type: 'pdf', dataUri: stored } }));
      } else if (record.fileType === 'docx') {
        const mammoth = await import('mammoth');
        const arrayBuffer = dataUriToArrayBuffer(stored);
        const result = await mammoth.convertToHtml({ arrayBuffer });
        setPreviewCache(prev => ({ ...prev, [record.id]: { status: 'ready', type: 'docx', html: result.value, dataUri: stored } }));
      } else {
        setPreviewCache(prev => ({ ...prev, [record.id]: { status: 'unsupported', type: record.fileType, dataUri: stored } }));
      }
    } catch (err) {
      setPreviewCache(prev => ({ ...prev, [record.id]: { status: 'error' } }));
    }
  };

  const togglePreview = (record) => {
    if (expandedId === record.id) { setExpandedId(null); return; }
    setExpandedId(record.id);
    if (!previewCache[record.id]) loadPreview(record);
  };

  const toggleCompare = (id) => {
    setCompareSelected(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 2) return prev;
      return [...prev, id];
    });
  };

  const openCompare = () => {
    setCompareOpen(true);
    compareSelected.forEach(id => {
      const rec = records.find(r => r.id === id);
      if (rec && !previewCache[id]) loadPreview(rec);
    });
  };

  const handleSubmit = async () => {
    if (!description.trim() || !pendingFile) return;
    setUploading(true);
    const id = uid();
    const ok = await safeSet(`mom-file:${projectId}:${id}`, pendingFile.dataUri, true);
    setUploading(false);
    if (!ok) { setFileError('Could not save the file — try again.'); return; }
    const meta = {
      id, description: description.trim(), meetingDate,
      fileName: pendingFile.fileName, fileType: pendingFile.fileType, sizeKB: pendingFile.sizeKB,
      createdAt: new Date().toISOString(),
    };
    saveRecords([...records, meta]);
    resetForm();
  };

  const removeRecord = async (record) => {
    await safeDelete(`mom-file:${projectId}:${record.id}`, true);
    saveRecords(records.filter(r => r.id !== record.id));
    setCompareSelected(prev => prev.filter(id => id !== record.id));
    if (expandedId === record.id) setExpandedId(null);
    setPreviewCache(prev => { const next = { ...prev }; delete next[record.id]; return next; });
  };

  const sorted = useMemo(() => [...records].sort((a, b) => (a.meetingDate < b.meetingDate ? 1 : -1)), [records]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>MOM / Record notes</h2>
        <div className="flex gap-2">
          {compareSelected.length === 2 && (
            <button
              onClick={openCompare}
              className="flex items-center gap-1.5 text-white px-3 py-1.5 rounded-sm text-sm"
              style={{ backgroundColor: '#3D6178' }}
            >
              Compare selected
            </button>
          )}
          <button
            onClick={() => { resetForm(); setShowForm(true); }}
            className="flex items-center gap-1.5 text-white px-3 py-1.5 rounded-sm text-sm"
            style={{ backgroundColor: '#D98E2B' }}
          >
            <Plus size={14} /> Add record
          </button>
        </div>
      </div>

      <p className="text-xs" style={{ color: '#8B8578' }}>
        Supports .pdf and .docx (previewable in-browser) and .doc (download only). Each file is capped at roughly 3.5 MB.
        Select up to two records with the checkboxes to compare them side by side.
      </p>

      {showForm && (
        <div className="tracker-card bg-white border rounded-sm p-4 space-y-3" style={{ borderColor: '#D9D2C2' }}>
          <h3 className="text-sm font-semibold" style={{ color: '#4A453C' }}>New record</h3>
          <input
            placeholder="Meeting description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }}
          />
          <div>
            <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Date of meeting</label>
            <input
              type="date" value={meetingDate}
              onChange={(e) => setMeetingDate(e.target.value)}
              className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }}
            />
          </div>
          <div>
            <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>File (.pdf, .docx, .doc)</label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.doc"
              onChange={handleFileChange}
              className="w-full text-sm"
            />
            {pendingFile && !fileError && (
              <p className="text-xs mt-1" style={{ color: '#4F7C52' }}>{pendingFile.fileName} · {fmtKB(pendingFile.sizeKB)} ready to save</p>
            )}
            {fileError && <p className="text-xs mt-1" style={{ color: '#B5482F' }}>{fileError}</p>}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSubmit}
              disabled={!description.trim() || !pendingFile || uploading}
              className="flex items-center gap-1.5 text-white px-3 py-1.5 rounded-sm text-sm"
              style={{ backgroundColor: (!description.trim() || !pendingFile || uploading) ? '#B7ADA0' : '#1C2733' }}
            >
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {uploading ? 'Saving...' : 'Add record'}
            </button>
            <button onClick={resetForm} className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-sm border" style={{ color: '#4A453C', borderColor: '#D9D2C2' }}>
              <X size={14} /> Cancel
            </button>
          </div>
        </div>
      )}

      {compareOpen && compareSelected.length === 2 && (
        <div className="tracker-card bg-white border rounded-sm p-3" style={{ borderColor: '#3D6178' }}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold" style={{ color: '#4A453C' }}>Comparing 2 records</h3>
            <X size={16} className="cursor-pointer" style={{ color: '#8B8578' }} onClick={() => setCompareOpen(false)} />
          </div>
          <div className="flex flex-col md:flex-row gap-3">
            {compareSelected.map(id => {
              const rec = records.find(r => r.id === id);
              if (!rec) return null;
              return (
                <div key={id} className="flex-1 min-w-0 border rounded-sm p-2" style={{ borderColor: '#D9D2C2' }}>
                  <p className="text-xs font-semibold truncate">{rec.description}</p>
                  <p className="text-xs mb-2" style={{ color: '#8B8578' }}>{fmtDate(rec.meetingDate)} · {rec.fileName}</p>
                  <MOMPreviewBody entry={previewCache[id]} fileName={rec.fileName} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="tracker-card bg-white border rounded-sm p-4" style={{ borderColor: '#D9D2C2' }}>
          <p className="text-sm" style={{ color: '#8B8578' }}>No meeting records yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map(rec => (
            <div key={rec.id} className="tracker-card bg-white border rounded-sm overflow-hidden" style={{ borderColor: '#D9D2C2' }}>
              <div className="flex items-start justify-between gap-2 p-3">
                <div className="flex items-start gap-2 min-w-0">
                  <input
                    type="checkbox"
                    checked={compareSelected.includes(rec.id)}
                    disabled={!compareSelected.includes(rec.id) && compareSelected.length >= 2}
                    onChange={() => toggleCompare(rec.id)}
                    className="mt-1"
                    title="Select to compare"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{rec.description}</p>
                    <p className="text-xs" style={{ color: '#8B8578' }}>
                      {fmtDate(rec.meetingDate)} · {rec.fileName} · {fmtKB(rec.sizeKB)}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => togglePreview(rec)} className="text-xs border px-2 py-1 rounded-sm" style={{ color: '#3D6178', borderColor: '#3D6178' }}>
                    {expandedId === rec.id ? 'Hide' : 'Preview'}
                  </button>
                  <Trash2 size={14} className="cursor-pointer mt-1" style={{ color: '#8B8578' }} onClick={() => removeRecord(rec)} />
                </div>
              </div>
              {expandedId === rec.id && (
                <div className="border-t p-2" style={{ borderColor: '#D9D2C2', backgroundColor: '#FAF8F2' }}>
                  <MOMPreviewBody entry={previewCache[rec.id]} fileName={rec.fileName} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Admin: user approvals ---------------- */
function AdminPage({ currentUserId }) {
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    const { data, error: err } = await supabase.from('profiles').select('*').order('created_at', { ascending: false });
    if (err) setError(err.message);
    else setProfiles(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const setApproved = async (id, approved) => {
    setBusyId(id);
    const { error: err } = await supabase.from('profiles').update({ approved }).eq('id', id);
    setBusyId(null);
    if (err) { setError(err.message); return; }
    setProfiles(prev => prev.map(p => p.id === id ? { ...p, approved } : p));
  };

  const pending = profiles.filter(p => !p.approved);
  const approved = profiles.filter(p => p.approved);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>User approvals</h2>
      {error && <p className="text-xs" style={{ color: '#B5482F' }}>{error}</p>}

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin" style={{ color: '#3D6178' }} /></div>
      ) : (
        <>
          <div className="tracker-card bg-white border rounded-sm overflow-hidden" style={{ borderColor: '#D9D2C2' }}>
            <div className="px-3 py-2 text-xs font-semibold border-b" style={{ borderColor: '#D9D2C2', color: '#4A453C' }}>
              Pending approval ({pending.length})
            </div>
            {pending.length === 0 ? (
              <p className="text-sm p-3" style={{ color: '#8B8578' }}>No accounts waiting for approval.</p>
            ) : (
              pending.map(p => (
                <div key={p.id} className="flex items-center justify-between p-3 border-b last:border-b-0" style={{ borderColor: '#EEE8DA' }}>
                  <div>
                    <p className="text-sm">{p.email}</p>
                    <p className="text-xs" style={{ color: '#8B8578' }}>Signed up {fmtDate(p.created_at.slice(0, 10))}</p>
                  </div>
                  <button
                    onClick={() => setApproved(p.id, true)}
                    disabled={busyId === p.id}
                    className="flex items-center gap-1.5 text-white px-3 py-1.5 rounded-sm text-sm"
                    style={{ backgroundColor: busyId === p.id ? '#B7ADA0' : '#4F7C52' }}
                  >
                    {busyId === p.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Approve
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="tracker-card bg-white border rounded-sm overflow-hidden" style={{ borderColor: '#D9D2C2' }}>
            <div className="px-3 py-2 text-xs font-semibold border-b" style={{ borderColor: '#D9D2C2', color: '#4A453C' }}>
              Approved ({approved.length})
            </div>
            {approved.map(p => (
              <div key={p.id} className="flex items-center justify-between p-3 border-b last:border-b-0" style={{ borderColor: '#EEE8DA' }}>
                <div className="flex items-center gap-2">
                  <p className="text-sm">{p.email}</p>
                  {p.is_admin && <Badge label="Admin" color="#3D6178" />}
                </div>
                {!p.is_admin && p.id !== currentUserId && (
                  <button
                    onClick={() => setApproved(p.id, false)}
                    disabled={busyId === p.id}
                    className="text-xs border px-2 py-1 rounded-sm"
                    style={{ color: '#B5482F', borderColor: '#B5482F' }}
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------- Insights (AI) ---------------- */
// How much project data is sent to the AI with each question. At roughly 4
// characters per token, 600,000 characters is about 150K tokens: well inside the
// model's context window, and enough for roughly 2,000 daily-log entries (about
// 200 characters each) plus everything else. Bigger requests answer more slowly and
// count more against free-tier token limits (check your quota in AI Studio). If a
// project's full data is bigger than this, the OLDEST daily-log and manpower history
// is dropped first (activities, procurement and everything else is always sent in
// full) and the Insights tab says so.
const MAX_CONTEXT_CHARS = 600000;

const AI_DATA_GUIDE = `You are an assistant answering questions about ONE construction project. Below is that project's COMPLETE data model as JSON (unless a NOTE says older history was left out). Use only this data. If something is not in it, say so instead of guessing.

How to answer:
- Be complete and specific. When asked for a list (overdue activities, delayed lots, who was on site, and so on), list every matching item with its key details rather than summarising or giving examples.
- Count by going through the lists carefully. The "summary" section has pre-computed counts you can rely on.
- Dates are YYYY-MM-DD. "today" is given in the data.

Data model:
- summary: pre-computed counts and totals.
- disciplines, areas, subcontractors: the project's configured lists.
- activities: one per activity. status is one of: Not yet started (no actual start, planned start not yet passed); Planned and progressing as per plan (started, not finished, planned finish not yet passed); Completed as per Plan; Completed with delay (finished after the planned finish); Overdue not started (no actual start and today is past the planned start); Overdue with delay (started, not finished, and today is past the planned finish). totalScope and balanceScope are quantities in the activity's own unit; percentComplete = (totalScope - balanceScope) / totalScope. balanceScope falls automatically as actual quantities are logged in the daily log. delayDays is how many days late, when late.
- manpowerByDay: headcount on site for each logged day: total, byDiscipline (a discipline not listed had nobody that day), and bySubcontractor (per discipline, only where a subcontractor breakdown was entered; when present it adds up to that discipline's headcount).
- dailyProgressLog: one entry per activity per day, with the plannedQty and actualQty for that day (in the activity's unit), manpower engaged, an optional subcontractor, and nested subActivities. A sub-activity has its own manpower, plannedQty, actualQty and uom; these are for tracking only and are NOT linked to the parent activity's quantities or unit.
- procurement: items, each with its lots. A lot has a quantity, supplier location, a status, expected and actual dates for orderPlacement, inspection, dispatch and delivery, and dated progress updates.
- meetingRecords: minutes-of-meeting files on record (date, description, file name). The contents of those files are NOT included.`;

// Builds the text sent to the AI: the guide above plus the project's complete data
// model as compact JSON. Returns { text, stats } where stats describes what was sent.
function buildProjectContext(project, opts = {}) {
  const maxChars = opts.maxChars || MAX_CONTEXT_CHARS;
  const {
    projectName, activities = [], manpower = {}, dailyLog = [], subActivities = [],
    procItems = [], procLots = [], procUpdates = [], momRecords = [],
    trades = [], areas = [], subcontractors = [],
  } = project;
  const today = todayStr();
  const num = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? undefined : Number(v));
  // Drop empty values so the JSON stays small.
  const compact = (o) => {
    const out = {};
    Object.entries(o).forEach(([k, v]) => {
      if (v === '' || v === null || v === undefined) return;
      if (Array.isArray(v) && v.length === 0) return;
      if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return;
      out[k] = v;
    });
    return out;
  };
  const byDate = (x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0);

  // ---- Activities
  const statusCounts = {};
  const actModel = activities.map(a => {
    const status = scheduleCategory(a);
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    const kind = overdueKind(a);
    const delayDays = a.actualEnd && a.plannedEnd && a.actualEnd > a.plannedEnd ? daysBetween(a.plannedEnd, a.actualEnd)
      : kind === 'notStarted' ? daysBetween(a.plannedStart || a.plannedEnd, today)
      : kind === 'delayed' ? daysBetween(a.plannedEnd, today) : 0;
    return compact({
      name: a.name, discipline: a.category, area: a.area, priority: a.priority, status,
      plannedStart: a.plannedStart, plannedEnd: a.plannedEnd, actualStart: a.actualStart, actualEnd: a.actualEnd,
      totalScope: num(a.totalScope), balanceScope: num(a.balanceScope), unit: a.unit,
      percentComplete: percentComplete(a) ?? undefined, delayDays: delayDays > 0 ? delayDays : undefined,
      assignedTo: a.assignedTo, notes: a.notes,
    });
  });

  // ---- Manpower, one record per logged day
  const mpFull = Object.keys(manpower).sort().map(date => {
    const e = manpower[date] || {};
    const byDiscipline = {};
    let total = 0;
    Object.entries(e.trades || {}).forEach(([d, v]) => {
      const n = Number(v || 0);
      total += n;
      if (n > 0) byDiscipline[d] = n;
    });
    const bySubcontractor = {};
    Object.entries(e.subBreakdown || {}).forEach(([d, rows]) => {
      (rows || []).forEach(r => {
        const n = Number(r.count || 0);
        if (!r.subcontractor || n <= 0) return;
        bySubcontractor[d] = bySubcontractor[d] || {};
        bySubcontractor[d][r.subcontractor] = (bySubcontractor[d][r.subcontractor] || 0) + n;
      });
    });
    return compact({ date, total, byDiscipline, bySubcontractor, notes: e.notes });
  });

  // ---- Daily progress log, with sub-activities nested under their entry
  const actById = Object.fromEntries(activities.map(a => [a.id, a]));
  const subsByEntry = {};
  subActivities.forEach(s => { (subsByEntry[s.entryId] = subsByEntry[s.entryId] || []).push(s); });
  const logFull = [...dailyLog].sort(byDate).map(e => {
    const a = actById[e.activityId];
    const subs = (subsByEntry[e.id] || []).map(s => compact({
      description: s.description, manpower: num(s.manpower), plannedQty: num(s.plannedQty),
      actualQty: num(s.actualQty), uom: s.uom, subcontractor: s.subcontractor,
    }));
    return compact({
      date: e.date, activity: a ? a.name : '(deleted activity)', discipline: a && a.category, area: a && a.area,
      plannedQty: num(e.plannedQty), actualQty: num(e.actualQty), unit: a && a.unit, manpower: num(e.manpower),
      subcontractor: e.subcontractor, subActivities: subs,
    });
  });

  // ---- Procurement: items > lots > updates
  const updatesByLot = {};
  procUpdates.forEach(u => { (updatesByLot[u.lotId] = updatesByLot[u.lotId] || []).push(u); });
  const lotsByItem = {};
  procLots.forEach(l => { (lotsByItem[l.itemId] = lotsByItem[l.itemId] || []).push(l); });
  const lotStatusCounts = {};
  const procurement = procItems.map(item => compact({
    name: item.name, discipline: item.discipline, supplier: item.supplier,
    lots: (lotsByItem[item.id] || []).map(lot => {
      const st = lotStatus(lot).label;
      lotStatusCounts[st] = (lotStatusCounts[st] || 0) + 1;
      const dates = {};
      PROC_STAGES.forEach(s => {
        const d = compact({ expected: lot[s.exp], actual: lot[s.act] });
        if (Object.keys(d).length) dates[s.key === 'order' ? 'orderPlacement' : s.key] = d;
      });
      return compact({
        lotNo: lot.lotNo, quantity: num(lot.quantity), supplierLocation: lot.supplierLocation, status: st, dates,
        updates: [...(updatesByLot[lot.id] || [])].sort(byDate).map(u => compact({ date: u.date, description: u.description })),
      });
    }),
  }));

  // ---- Meeting records (metadata only; the uploaded files' contents are not sent)
  const meetingRecords = [...momRecords]
    .sort((x, y) => (x.meetingDate < y.meetingDate ? -1 : x.meetingDate > y.meetingDate ? 1 : 0))
    .map(m => compact({ date: m.meetingDate, description: m.description, fileName: m.fileName }));

  // ---- Pre-computed summary, so the model doesn't have to count long lists itself
  const withScope = activities.filter(a => a.totalScope && Number(a.totalScope) > 0);
  const avgPct = withScope.length
    ? Math.round(withScope.reduce((s, a) => s + (percentComplete(a) || 0), 0) / withScope.length) : undefined;
  const lastDay = mpFull[mpFull.length - 1];
  const summary = compact({
    activities: activities.length,
    activityStatusCounts: statusCounts,
    overdueActivities: (statusCounts['Overdue not started'] || 0) + (statusCounts['Overdue with delay'] || 0),
    averagePercentCompleteWhereScopeTracked: avgPct,
    manpowerDaysLogged: mpFull.length,
    latestManpowerDay: lastDay ? { date: lastDay.date, total: lastDay.total } : undefined,
    dailyLogEntries: logFull.length,
    procurementItems: procItems.length,
    procurementLots: procLots.length,
    procurementLotStatusCounts: lotStatusCounts,
    meetingRecords: meetingRecords.length,
  });

  const model = {
    project: projectName || 'Untitled', today, summary,
    disciplines: trades, areas, subcontractors,
    activities: actModel, procurement, meetingRecords,
    manpowerByDay: [], dailyProgressLog: [],
  };

  // ---- Fit within the size budget by dropping the OLDEST history first
  let keepLog = logFull.length;
  let keepMp = mpFull.length;
  const render = () => {
    model.manpowerByDay = mpFull.slice(mpFull.length - keepMp);
    model.dailyProgressLog = logFull.slice(logFull.length - keepLog);
    let notice = '';
    if (keepLog < logFull.length || keepMp < mpFull.length) {
      const logFrom = model.dailyProgressLog.length ? model.dailyProgressLog[0].date : 'none';
      const mpFrom = model.manpowerByDay.length ? model.manpowerByDay[0].date : 'none';
      notice = 'NOTE: this project has more history than fits in one request, so older history was left out. '
        + 'Daily-log entries included: ' + (keepLog ? 'the most recent ' + keepLog + ' of ' + logFull.length + ' (from ' + logFrom + ')' : 'none of ' + logFull.length)
        + '. Manpower days included: ' + (keepMp ? 'the most recent ' + keepMp + ' of ' + mpFull.length + ' (from ' + mpFrom + ')' : 'none of ' + mpFull.length)
        + '. Activities, procurement and everything else are complete. If a question needs older history, say it is not available here.';
    }
    return { notice, text: AI_DATA_GUIDE + (notice ? '\n\n' + notice : '') + '\n\nPROJECT DATA (JSON):\n' + JSON.stringify(model) };
  };
  let out = render();
  while (out.text.length > maxChars && (keepLog > 0 || keepMp > 0)) {
    keepLog = Math.floor(keepLog * 0.8);
    keepMp = Math.floor(keepMp * 0.8);
    out = render();
  }

  return {
    text: out.text,
    stats: {
      activities: actModel.length,
      manpowerDays: model.manpowerByDay.length, manpowerDaysTotal: mpFull.length,
      dailyEntries: model.dailyProgressLog.length, dailyEntriesTotal: logFull.length,
      subActivities: model.dailyProgressLog.reduce((n, e) => n + (e.subActivities ? e.subActivities.length : 0), 0),
      procurementItems: procurement.length, procurementLots: procLots.length,
      meetingRecords: meetingRecords.length,
      chars: out.text.length, approxTokens: Math.round(out.text.length / 4), notice: out.notice,
    },
  };
}

function InsightsPage({ projectName, activities, manpower, dailyLog, subActivities, procItems, procLots, procUpdates, momRecords, trades, areas, subcontractors }) {
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastPrompt, setLastPrompt] = useState('');
  const [meta, setMeta] = useState(null);

  const suggestions = [
    'What activities are overdue and by how much?',
    "How is today's manpower compared to the last week?",
    'What procurement lots are delayed?',
    'Which subcontractors are on site, and in which disciplines?',
    'Summarize overall project progress.',
  ];

  const ask = async (question) => {
    const q = (question ?? prompt).trim();
    if (!q || busy) return;
    setBusy(true);
    setError('');
    setAnswer('');
    setMeta(null);
    setLastPrompt(q);
    try {
      const { text: context, stats } = buildProjectContext({
        projectName, activities, manpower, dailyLog, subActivities,
        procItems, procLots, procUpdates, momRecords, trades, areas, subcontractors,
      });
      const { data, error: fnError } = await supabase.functions.invoke('ai-insights', { body: { prompt: q, context } });
      if (fnError) {
        // supabase-js's own message is just "Edge Function returned a non-2xx status
        // code" — the useful detail is in the response body, on fnError.context.
        let detail = fnError.message || 'Edge Function request failed.';
        const ctx = fnError.context;
        if (ctx) {
          try {
            const body = typeof ctx.json === 'function' ? await ctx.json() : ctx;
            if (body?.error) detail = body.error;
          } catch (e) { /* fall back to the generic message */ }
        }
        throw new Error(detail);
      }
      if (data?.error) throw new Error(data.error);
      setAnswer(data?.answer || 'No answer returned.');
      setMeta({ stats, cutOff: data?.finishReason === 'MAX_TOKENS' });
    } catch (err) {
      setError(err.message || 'Something went wrong asking for insights.');
    } finally {
      setBusy(false);
    }
  };

  const s = meta && meta.stats;

  return (
    <div className="space-y-4">
      <style>{`
        .insights-answer { scrollbar-width: thin; scrollbar-color: #B7ADA0 #F1EDE4; }
        .insights-answer::-webkit-scrollbar { width: 10px; }
        .insights-answer::-webkit-scrollbar-track { background: #F1EDE4; border-radius: 5px; }
        .insights-answer::-webkit-scrollbar-thumb { background: #B7ADA0; border-radius: 5px; }
      `}</style>
      <h2 className="text-lg font-semibold" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>Insights</h2>
      <p className="text-xs" style={{ color: '#8B8578' }}>
        Ask a question about this project. The complete project data — activities, manpower with subcontractor
        breakdowns, the daily log and sub-activities, procurement lots and updates, and meeting records (details only,
        not the files) — is sent with your question so the answer can draw on all of it.
      </p>

      <div className="flex flex-wrap gap-2">
        {suggestions.map(sg => (
          <button
            key={sg}
            onClick={() => { setPrompt(sg); ask(sg); }}
            disabled={busy}
            className="text-xs border px-2.5 py-1 rounded-sm"
            style={{ color: '#3D6178', borderColor: '#3D6178' }}
          >
            {sg}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask()}
          placeholder="Ask about this project..."
          className="flex-1 border rounded-sm px-3 py-2 text-sm" style={{ borderColor: '#D9D2C2' }}
        />
        <button
          onClick={() => ask()}
          disabled={busy || !prompt.trim()}
          className="flex items-center gap-1.5 text-white px-4 py-2 rounded-sm text-sm"
          style={{ backgroundColor: (busy || !prompt.trim()) ? '#B7ADA0' : '#1C2733' }}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          Ask
        </button>
      </div>

      {error && (
        <div className="tracker-card bg-white border rounded-sm p-3" style={{ borderColor: '#B5482F' }}>
          <p className="text-xs" style={{ color: '#B5482F' }}>{error}</p>
        </div>
      )}

      {(answer || busy) && (
        <div className="tracker-card bg-white border rounded-sm p-4" style={{ borderColor: '#D9D2C2' }}>
          {lastPrompt && <p className="text-xs mb-2 font-medium" style={{ color: '#4A453C' }}>{lastPrompt}</p>}
          {busy ? (
            <div className="flex items-center gap-2">
              <Loader2 size={16} className="animate-spin" style={{ color: '#3D6178' }} />
              <span className="text-xs" style={{ color: '#8B8578' }}>Thinking...</span>
            </div>
          ) : (
            <div
              className="insights-answer text-sm whitespace-pre-wrap pr-2"
              style={{ color: '#2A2620', maxHeight: '60vh', overflowY: 'auto', overflowWrap: 'anywhere' }}
            >
              {answer}
            </div>
          )}
          {!busy && meta && meta.cutOff && (
            <p className="text-xs mt-3" style={{ color: '#D98E2B' }}>
              This answer hit the model's length limit and was cut off. Ask a narrower question (one discipline, area or
              date range) to get the rest.
            </p>
          )}
          {!busy && s && (
            <p className="text-xs mt-3" style={{ color: '#8B8578' }}>
              Based on {s.activities} activities, {s.manpowerDays} days of manpower, {s.dailyEntries} daily-log entries
              ({s.subActivities} sub-activities), {s.procurementItems} procurement items ({s.procurementLots} lots) and{' '}
              {s.meetingRecords} meeting records (~{Math.round(s.approxTokens / 1000)}K tokens).
              {s.notice ? ' ' + s.notice : ''}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Reports ---------------- */
const REPORT_DAILY_DAYS = 30;  // the daily manpower charts cover the last 30 logged days
const REPORT_MONTHS = 12;      // the monthly manpower charts cover the last 12 months

// Everything the report shows, computed from the app's current data at this moment.
function buildReport({ activities = [], manpower = {}, procItems = [], procLots = [], procUpdates = [], trades = [] }) {
  const generatedAt = new Date();
  const today = todayStr();

  // ---- 1. Manpower: one row per logged day, and per month (sum of the daily totals)
  const dates = Object.keys(manpower).sort();
  const disciplineSet = new Set(trades);
  dates.forEach(d => Object.keys((manpower[d] || {}).trades || {}).forEach(k => disciplineSet.add(k)));
  const disciplines = Array.from(disciplineSet);
  const dailyBase = dates.map(date => {
    const byDiscipline = {};
    let total = 0;
    Object.entries((manpower[date] || {}).trades || {}).forEach(([k, v]) => {
      const n = Number(v || 0);
      total += n;
      if (n > 0) byDiscipline[k] = n;
    });
    return { date, label: fmtDateShort(date), total, byDiscipline };
  });
  const manpowerDaily = dailyBase.map((r, i) => ({ ...r, change: i > 0 ? r.total - dailyBase[i - 1].total : null }));
  const monthTotals = {};
  manpowerDaily.forEach(r => { const mk = r.date.slice(0, 7); monthTotals[mk] = (monthTotals[mk] || 0) + r.total; });
  const monthKeys = Object.keys(monthTotals).sort();
  const manpowerMonthly = monthKeys.map((month, i) => ({
    month,
    label: new Date(month + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
    total: monthTotals[month],
    change: i > 0 ? monthTotals[month] - monthTotals[monthKeys[i - 1]] : null,
  }));
  const latestDay = manpowerDaily.length ? manpowerDaily[manpowerDaily.length - 1] : null;

  // ---- 2. Pending activities (anything not completed), most urgent first
  const statusOrder = {
    'Overdue with delay': 0, 'Overdue not started': 1,
    'Planned and progressing as per plan': 2, 'Not yet started': 3,
  };
  const pendingActivities = activities.filter(a => !isDone(a)).map(a => {
    const kind = overdueKind(a);
    const delayDays = kind === 'notStarted' ? daysBetween(a.plannedStart || a.plannedEnd, today)
      : kind === 'delayed' ? daysBetween(a.plannedEnd, today) : 0;
    return {
      name: a.name, discipline: a.category || '', area: a.area || '', status: scheduleCategory(a),
      plannedStart: a.plannedStart || '', plannedEnd: a.plannedEnd || '', actualStart: a.actualStart || '',
      totalScope: a.totalScope ?? '', balanceScope: a.balanceScope ?? '', unit: a.unit || '',
      pct: percentComplete(a), delayDays, assignedTo: a.assignedTo || '',
    };
  }).sort((x, y) => ((statusOrder[x.status] ?? 9) - (statusOrder[y.status] ?? 9))
    || String(x.plannedEnd || '9999').localeCompare(String(y.plannedEnd || '9999'))
    || String(x.name).localeCompare(String(y.name)));
  const tracked = pendingActivities.filter(a => a.pct !== null);
  const activitySummary = {
    pending: pendingActivities.length,
    overdue: pendingActivities.filter(a => /^Overdue/.test(a.status)).length,
    averagePct: tracked.length ? Math.round(tracked.reduce((s, a) => s + a.pct, 0) / tracked.length) : null,
  };

  // ---- 3. Pending procurement: every lot not yet delivered, plus items with no lots yet
  const lotsByItem = {};
  procLots.forEach(l => { (lotsByItem[l.itemId] = lotsByItem[l.itemId] || []).push(l); });
  const updatesByLot = {};
  procUpdates.forEach(u => { (updatesByLot[u.lotId] = updatesByLot[u.lotId] || []).push(u); });
  const pendingProcurement = [];
  procItems.forEach(item => {
    const lots = lotsByItem[item.id] || [];
    if (lots.length === 0) {
      pendingProcurement.push({
        itemId: item.id, item: item.name, discipline: item.discipline || '', supplier: item.supplier || '',
        lotNo: '', quantity: '', location: '', status: 'No lots recorded yet', statusColor: '#8B8578',
        overdue: false, stages: [], latestUpdate: null, sortKey: '9999-12-31',
      });
      return;
    }
    lots.filter(l => !l.actDelivery).forEach(lot => {
      const st = lotStatus(lot);
      const next = PROC_STAGES.find(s => !lot[s.act]);
      const ups = [...(updatesByLot[lot.id] || [])].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      pendingProcurement.push({
        itemId: item.id, item: item.name, discipline: item.discipline || '', supplier: item.supplier || '',
        lotNo: lot.lotNo || '', quantity: lot.quantity ?? '', location: lot.supplierLocation || '',
        status: st.label, statusColor: st.color, overdue: /overdue/i.test(st.label),
        stages: PROC_STAGES.map(s => ({ key: s.key, label: s.label, expected: lot[s.exp] || '', actual: lot[s.act] || '' })),
        latestUpdate: ups.length ? { date: ups[0].date, description: ups[0].description } : null,
        sortKey: (next && lot[next.exp]) || '9999-12-30',
      });
    });
  });
  pendingProcurement.sort((a, b) => (Number(b.overdue) - Number(a.overdue))
    || a.sortKey.localeCompare(b.sortKey) || String(a.item).localeCompare(String(b.item)));
  const lotRows = pendingProcurement.filter(r => r.stages.length > 0);
  const procurementSummary = {
    pendingLots: lotRows.length,
    overdueLots: lotRows.filter(r => r.overdue).length,
    itemsWithPendingLots: new Set(lotRows.map(r => r.itemId)).size,
    itemsWithNoLots: pendingProcurement.length - lotRows.length,
  };

  return {
    generatedAt, disciplines, manpowerDaily, manpowerMonthly, latestDay,
    pendingActivities, activitySummary, pendingProcurement, procurementSummary,
  };
}

// The same report as plain sheets (rows of cells), for the Excel download.
function reportToSheets(report) {
  const toNum = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? (v ?? '') : Number(v));
  const stage = (r, i, field) => (r.stages[i] ? r.stages[i][field] : '');
  return [
    {
      name: 'Manpower - Daily',
      rows: [
        ['Date', 'Total', 'Change vs previous logged day', ...report.disciplines],
        ...report.manpowerDaily.map(r => [r.date, r.total, r.change ?? '', ...report.disciplines.map(d => r.byDiscipline[d] || 0)]),
      ],
    },
    {
      name: 'Manpower - Monthly',
      rows: [
        ['Month', 'Man-days (sum of daily totals)', 'Change vs previous month'],
        ...report.manpowerMonthly.map(r => [r.month, r.total, r.change ?? '']),
      ],
    },
    {
      name: 'Pending activities',
      rows: [
        ['Activity', 'Discipline', 'Area', 'Status', 'Planned start', 'Planned finish', 'Actual start',
          '% complete', 'Total scope', 'Balance scope', 'Unit', 'Days late', 'Assigned to'],
        ...report.pendingActivities.map(a => [
          a.name, a.discipline, a.area, a.status, a.plannedStart, a.plannedEnd, a.actualStart,
          a.pct ?? '', toNum(a.totalScope), toNum(a.balanceScope), a.unit, a.delayDays || '', a.assignedTo,
        ]),
      ],
    },
    {
      name: 'Pending procurement',
      rows: [
        ['Item', 'Discipline', 'Supplier', 'Lot', 'Quantity', 'Supplier location', 'Status',
          ...PROC_STAGES.flatMap(s => [s.label + ' - expected', s.label + ' - actual']),
          'Latest update date', 'Latest update'],
        ...report.pendingProcurement.map(r => [
          r.item, r.discipline, r.supplier, r.lotNo, toNum(r.quantity), r.location, r.status,
          ...PROC_STAGES.flatMap((s, i) => [stage(r, i, 'expected'), stage(r, i, 'actual')]),
          r.latestUpdate ? r.latestUpdate.date : '', r.latestUpdate ? r.latestUpdate.description : '',
        ]),
      ],
    },
  ];
}

async function downloadReportXlsx(report, projectName) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  reportToSheets(report).forEach(sh => {
    const ws = XLSX.utils.aoa_to_sheet(sh.rows);
    ws['!cols'] = sh.rows[0].map((h, i) => ({
      wch: Math.min(45, Math.max(String(h).length + 2, ...sh.rows.slice(1, 80).map(r => String(r[i] ?? '').length + 2))),
    }));
    XLSX.utils.book_append_sheet(wb, ws, sh.name);
  });
  const safe = String(projectName || 'project').replace(/[^\w-]+/g, '_');
  XLSX.writeFile(wb, safe + '_report_' + todayStr() + '.xlsx');
}

// ---- PowerPoint export (built with pptxgenjs; the library is only loaded when the button is clicked)
const PPT = {
  font: 'Calibri', navy: '1C2733', navy2: '28394A', steel: '3D6178', amber: 'D98E2B',
  ink: '2A2620', ink2: '4A453C', mute: '8B8578', line: 'EEE8DA', paper: 'F1EDE4', green: '4F7C52', red: 'B5482F',
};
const pptHex = (c) => (String(c || '').replace('#', '') || PPT.mute);
const pptTrim = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const pptDate = (s) => (s ? new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');
const PPT_ACTIVITY_ROWS = 9;   // pending activities per slide
const PPT_PROCUREMENT_ROWS = 7; // pending procurement lots per slide

// Turns a report (from buildReport) into a PowerPoint deck. `PptxGenJS` is the library's
// constructor, passed in so this stays testable.
function buildReportPptx(PptxGenJS, report, projectName) {
  const pres = new PptxGenJS();
  const name = projectName || 'Project';
  const stamp = report.generatedAt.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  pres.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pres.title = name + ' - status report';
  pres.theme = { headFontFace: PPT.font, bodyFontFace: PPT.font };

  pres.defineSlideMaster({
    title: 'REPORT',
    background: { color: 'FFFFFF' },
    objects: [{ text: { text: pptTrim(name, 60) + ' - status report  |  ' + stamp, options: { x: 0.5, y: 7.02, w: 10, h: 0.3, fontFace: PPT.font, fontSize: 10, color: PPT.mute, valign: 'middle', margin: 0 } } }],
    slideNumber: { x: 12.2, y: 7.02, w: 0.63, h: 0.3, fontFace: PPT.font, fontSize: 10, color: PPT.mute, align: 'right' },
  });
  pres.defineSlideMaster({ title: 'COVER', background: { color: PPT.navy } });

  const addTitle = (slide, text, subtitle) => {
    slide.addText(text, { x: 0.5, y: 0.35, w: 12.3, h: 0.7, fontFace: PPT.font, fontSize: 30, bold: true, color: PPT.navy, align: 'left', valign: 'middle', margin: 0, isTextBox: true });
    if (subtitle) {
      slide.addText(subtitle, { x: 0.5, y: 1.05, w: 12.3, h: 0.4, fontFace: PPT.font, fontSize: 14, color: PPT.mute, align: 'left', valign: 'top', margin: 0, isTextBox: true });
    }
  };
  const addEmpty = (slide, text) => {
    slide.addText(text, { x: 0.5, y: 2.6, w: 12.3, h: 1.0, fontFace: PPT.font, fontSize: 20, color: PPT.mute, align: 'left', valign: 'middle', margin: 0, isTextBox: true });
  };

  const { activitySummary, procurementSummary, latestDay } = report;

  // ---- Cover
  const cover = pres.addSlide({ masterName: 'COVER' });
  cover.addText(name, { x: 0.7, y: 1.0, w: 11.9, h: 1.1, fontFace: PPT.font, fontSize: name.length > 34 ? 32 : 44, bold: true, color: 'FFFFFF', align: 'left', valign: 'middle', margin: 0, isTextBox: true });
  cover.addText('Status report', { x: 0.7, y: 2.15, w: 11.9, h: 0.55, fontFace: PPT.font, fontSize: 24, color: PPT.amber, align: 'left', valign: 'middle', margin: 0, isTextBox: true });
  cover.addText('Generated ' + stamp, { x: 0.7, y: 2.75, w: 11.9, h: 0.4, fontFace: PPT.font, fontSize: 14, color: '8FA3B3', align: 'left', valign: 'middle', margin: 0, isTextBox: true });
  const cards = [
    [latestDay ? String(latestDay.total) : '—', latestDay ? 'on site on the latest logged day (' + fmtDate(latestDay.date) + ')' : 'No manpower logged yet'],
    [String(activitySummary.pending), 'pending activities' + (activitySummary.overdue ? ' · ' + activitySummary.overdue + ' overdue' : '')],
    [String(procurementSummary.pendingLots), 'procurement lots not yet delivered' + (procurementSummary.overdueLots ? ' · ' + procurementSummary.overdueLots + ' overdue' : '')],
  ];
  cards.forEach(([big, label], i) => {
    const x = 0.7 + i * 4.07;
    cover.addShape(pres.shapes.RECTANGLE, { x, y: 4.0, w: 3.85, h: 2.1, fill: { color: PPT.navy2 }, line: { color: PPT.steel, width: 1 } });
    cover.addText(big, { x: x + 0.25, y: 4.2, w: 3.35, h: 1.0, fontFace: PPT.font, fontSize: 48, bold: true, color: 'FFFFFF', align: 'left', valign: 'middle', margin: 0, isTextBox: true });
    cover.addText(label, { x: x + 0.25, y: 5.2, w: 3.35, h: 0.75, fontFace: PPT.font, fontSize: 14, color: '8FA3B3', align: 'left', valign: 'top', margin: 0, isTextBox: true });
  });

  // ---- Manpower: two slides (daily, monthly), each with a level chart and a change chart
  const chartOpts = (title, extra) => ({
    barDir: 'col', chartColors: [PPT.steel], showLegend: false,
    showTitle: true, title, titleFontSize: 14, titleColor: PPT.ink2, titleFontFace: '+mn-lt',
    showValue: true, dataLabelPosition: 'outEnd', dataLabelFontSize: 9, dataLabelColor: PPT.ink2, dataLabelFontFace: '+mn-lt', dataLabelFormatCode: '#,##0',
    catAxisLabelFontSize: 9, catAxisLabelColor: PPT.mute, catAxisLabelFontFace: '+mn-lt', catAxisLabelRotate: 270,
    valAxisLabelFontSize: 9, valAxisLabelColor: PPT.mute, valAxisLabelFontFace: '+mn-lt', valAxisLabelFormatCode: '#,##0',
    valGridLine: { color: PPT.line, size: 0.5 }, catGridLine: { style: 'none' }, barGapWidthPct: 40,
    ...extra,
  });
  const addManpowerSlide = (title, subtitle, left, right) => {
    const slide = pres.addSlide({ masterName: 'REPORT' });
    addTitle(slide, title, subtitle);
    [[left, 0.5, false], [right, 6.75, true]].forEach(([c, x, signed]) => {
      if (c.labels.length === 0) {
        slide.addText(c.title + ': nothing logged yet.', { x, y: 2.6, w: 6.05, h: 1.0, fontFace: PPT.font, fontSize: 16, color: PPT.mute, align: 'left', valign: 'middle', margin: 0, isTextBox: true });
        return;
      }
      const extra = { x, y: 1.6, w: 6.05, h: 5.2 };
      if (signed) Object.assign(extra, { chartColors: [PPT.green], invertedColors: [PPT.red], dataLabelFormatCode: '+#,##0;-#,##0;0' });
      slide.addChart(pres.charts.BAR, [{ name: c.title, labels: c.labels, values: c.values }], chartOpts(c.title, extra));
    });
  };
  const daily = report.manpowerDaily.slice(-REPORT_DAILY_DAYS);
  const dailyChange = daily.filter(d => d.change !== null);
  const monthly = report.manpowerMonthly.slice(-REPORT_MONTHS);
  const monthlyChange = monthly.filter(d => d.change !== null);
  addManpowerSlide(
    'Manpower - daily',
    latestDay
      ? 'Latest logged day ' + fmtDate(latestDay.date) + ': ' + latestDay.total + ' on site'
        + (Object.keys(latestDay.byDiscipline).length ? ' (' + Object.entries(latestDay.byDiscipline).map(([d, n]) => d + ' ' + n).join(', ') + ')' : '') + '.'
      : 'No manpower has been logged yet.',
    { title: 'Daily manpower (last ' + daily.length + ' logged days)', labels: daily.map(d => d.label), values: daily.map(d => d.total) },
    { title: 'Day-over-day change', labels: dailyChange.map(d => d.label), values: dailyChange.map(d => d.change) },
  );
  addManpowerSlide(
    'Manpower - monthly',
    'Man-days per month: the sum of each month\'s daily totals.',
    { title: 'Monthly manpower, man-days (last ' + monthly.length + ' months)', labels: monthly.map(d => d.label), values: monthly.map(d => d.total) },
    { title: 'Month-over-month change', labels: monthlyChange.map(d => d.label), values: monthlyChange.map(d => d.change) },
  );

  // ---- Pending activities: one row per activity, a progress bar showing % of scope completed
  const acts = report.pendingActivities;
  const actPages = Math.max(1, Math.ceil(acts.length / PPT_ACTIVITY_ROWS));
  const actSub = activitySummary.pending + ' pending · ' + activitySummary.overdue + ' overdue'
    + (activitySummary.averagePct !== null ? ' · average completion ' + activitySummary.averagePct + '% (where scope is tracked)' : '');
  for (let p = 0; p < actPages; p++) {
    const slide = pres.addSlide({ masterName: 'REPORT' });
    addTitle(slide, 'Pending activities - completion' + (actPages > 1 ? ' (' + (p + 1) + ' of ' + actPages + ')' : ''), actSub);
    if (acts.length === 0) { addEmpty(slide, 'No pending activities.'); continue; }
    acts.slice(p * PPT_ACTIVITY_ROWS, (p + 1) * PPT_ACTIVITY_ROWS).forEach((a, i) => {
      const y = 1.65 + i * 0.58;
      const color = pptHex(CATEGORY_COLORS[a.status]);
      const base = [a.discipline, a.area].filter(Boolean).join(' · ');
      const runs = [];
      if (base) runs.push({ text: pptTrim(base, 26) + ' · ', options: { color: PPT.mute } });
      runs.push({ text: a.status, options: { color, bold: true } });
      const extra = (a.delayDays > 0 ? ' · ' + a.delayDays + 'd late' : '') + (a.plannedEnd ? ' · due ' + pptDate(a.plannedEnd) : '');
      if (extra) runs.push({ text: extra, options: { color: PPT.mute } });
      slide.addText(pptTrim(a.name, 56), { x: 0.5, y, w: 6.7, h: 0.3, fontFace: PPT.font, fontSize: 14, color: PPT.ink, align: 'left', valign: 'middle', margin: 0, isTextBox: true });
      slide.addText(runs, { x: 0.5, y: y + 0.28, w: 6.7, h: 0.24, fontFace: PPT.font, fontSize: 11, align: 'left', valign: 'middle', margin: 0, isTextBox: true });
      slide.addShape(pres.shapes.RECTANGLE, { x: 7.35, y: y + 0.12, w: 4.5, h: 0.26, fill: { color: PPT.line }, line: { type: 'none' } });
      if (a.pct !== null && a.pct > 0) {
        slide.addShape(pres.shapes.RECTANGLE, { x: 7.35, y: y + 0.12, w: Math.max(0.05, 4.5 * a.pct / 100), h: 0.26, fill: { color }, line: { type: 'none' } });
      }
      slide.addText(a.pct === null ? 'n/a' : a.pct + '%', { x: 11.95, y, w: 0.88, h: 0.5, fontFace: PPT.font, fontSize: 16, bold: true, color: a.pct === null ? PPT.mute : PPT.ink, align: 'right', valign: 'middle', margin: 0, isTextBox: true });
      slide.addShape(pres.shapes.LINE, { x: 0.5, y: y + 0.55, w: 12.33, h: 0, line: { color: PPT.line, width: 0.75 } });
    });
  }

  // ---- Pending procurement: a table, a lot per row
  const lots = report.pendingProcurement;
  const procPages = Math.max(1, Math.ceil(lots.length / PPT_PROCUREMENT_ROWS));
  const procSub = procurementSummary.pendingLots + ' lot' + (procurementSummary.pendingLots === 1 ? '' : 's') + ' not yet delivered across '
    + procurementSummary.itemsWithPendingLots + ' item' + (procurementSummary.itemsWithPendingLots === 1 ? '' : 's')
    + (procurementSummary.overdueLots ? ' · ' + procurementSummary.overdueLots + ' overdue' : '')
    + (procurementSummary.itemsWithNoLots ? ' · ' + procurementSummary.itemsWithNoLots + ' item' + (procurementSummary.itemsWithNoLots === 1 ? '' : 's') + ' with no lots yet' : '');
  const noBorder = { type: 'none' };
  const rowBorder = [noBorder, noBorder, { type: 'solid', pt: 0.5, color: PPT.line }, noBorder];
  for (let p = 0; p < procPages; p++) {
    const slide = pres.addSlide({ masterName: 'REPORT' });
    addTitle(slide, 'Pending procurement' + (procPages > 1 ? ' (' + (p + 1) + ' of ' + procPages + ')' : ''), procSub);
    if (lots.length === 0) { addEmpty(slide, 'Nothing pending - every lot has been delivered.'); continue; }
    const head = ['Item', 'Lot', 'Status', ...PROC_STAGES.map(s => s.label), 'Latest update'].map(h => ({
      text: h, options: { bold: true, color: PPT.ink2, fill: { color: PPT.paper }, fontSize: 10, fontFace: PPT.font, valign: 'middle', border: rowBorder },
    }));
    const body = lots.slice(p * PPT_PROCUREMENT_ROWS, (p + 1) * PPT_PROCUREMENT_ROWS).map(r => {
      const cell = (text, extra) => ({ text, options: { fontSize: 10, fontFace: PPT.font, color: PPT.ink, valign: 'top', border: rowBorder, ...extra } });
      const itemRuns = [
        { text: pptTrim(r.item, 40), options: { bold: true, fontSize: 11, color: PPT.ink, breakLine: true } },
        { text: pptTrim([r.discipline, r.supplier].filter(Boolean).join(' · ') || '—', 40), options: { color: PPT.mute, fontSize: 10 } },
      ];
      const lotRuns = r.lotNo ? [{ text: 'Lot ' + r.lotNo, options: { bold: true, color: PPT.ink, breakLine: !!(r.quantity !== '' || r.location) } }] : [{ text: '—', options: { color: PPT.mute } }];
      if (r.lotNo && r.quantity !== '') lotRuns.push({ text: 'Qty ' + r.quantity, options: { color: PPT.mute, breakLine: !!r.location } });
      if (r.lotNo && r.location) lotRuns.push({ text: pptTrim(r.location, 16), options: { color: PPT.mute } });
      const stageCells = PROC_STAGES.map((s, si) => {
        const st = r.stages[si];
        if (!st || (!st.expected && !st.actual)) return cell('—', { color: PPT.mute });
        const late = st.expected && st.actual && st.actual > st.expected;
        const overdueNow = st.expected && !st.actual && st.expected < todayStr();
        return cell([
          { text: 'Exp ' + pptDate(st.expected), options: { color: PPT.mute, breakLine: true } },
          { text: st.actual ? 'Act ' + pptDate(st.actual) : (overdueNow ? 'Overdue' : 'Act —'), options: { color: late || overdueNow ? PPT.red : PPT.ink, bold: !!st.actual || overdueNow } },
        ]);
      });
      const upd = r.latestUpdate
        ? cell([{ text: pptDate(r.latestUpdate.date), options: { color: PPT.mute, breakLine: true } }, { text: pptTrim(r.latestUpdate.description, 70), options: { color: PPT.ink } }])
        : cell('—', { color: PPT.mute });
      return [cell(itemRuns), cell(lotRuns), cell(r.status, { color: pptHex(r.statusColor), bold: true }), ...stageCells, upd];
    });
    const rows = [head, ...body];
    slide.addTable(rows, {
      x: 0.5, y: 1.6, w: 12.3, colW: [2.3, 1.3, 1.4, 1.25, 1.25, 1.25, 1.25, 2.3],
      rowH: rows.map((_, i) => (i === 0 ? 0.35 : 0.7)), fontFace: PPT.font, fontSize: 10, margin: [0.04, 0.06, 0.04, 0.06],
    });
  }

  return pres;
}

// pptxgenjs leaves empty "folder" entries inside the .pptx (which is a ZIP). Some cloud viewers
// (PowerPoint for the web, OneDrive) have refused such files, so they are removed here by
// copying every real entry untouched and rewriting the ZIP's directory. If the file doesn't
// look exactly as expected, it is returned unchanged rather than risk damaging it.
function stripZipFolderEntries(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return data;
  const total = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (total === 0xffff || cdOffset === 0xffffffff) return data; // ZIP64: leave alone
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > data.length || dv.getUint32(p, true) !== 0x02014b50) return data;
    const flags = dv.getUint16(p + 8, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const recLen = 46 + nameLen + extraLen + commentLen;
    if (flags & 0x08) return data; // sizes stored after the data: don't risk it
    if (localOffset + 30 > data.length || dv.getUint32(localOffset, true) !== 0x04034b50) return data;
    const localLen = 30 + dv.getUint16(localOffset + 26, true) + dv.getUint16(localOffset + 28, true) + compSize;
    if (localOffset + localLen > data.length) return data;
    entries.push({ p, recLen, localOffset, localLen, isDir: data[p + 46 + nameLen - 1] === 0x2f });
    p += recLen;
  }
  if (!entries.some(e => e.isDir)) return data;
  const kept = entries.filter(e => !e.isDir);
  const eocdLen = 22 + dv.getUint16(eocd + 20, true);
  const out = new Uint8Array(kept.reduce((s, e) => s + e.localLen + e.recLen, 0) + eocdLen);
  const odv = new DataView(out.buffer);
  let pos = 0;
  const newOffsets = kept.map(e => { const at = pos; out.set(data.subarray(e.localOffset, e.localOffset + e.localLen), pos); pos += e.localLen; return at; });
  const cdStart = pos;
  kept.forEach((e, i) => { out.set(data.subarray(e.p, e.p + e.recLen), pos); odv.setUint32(pos + 42, newOffsets[i], true); pos += e.recLen; });
  const cdLen = pos - cdStart;
  out.set(data.subarray(eocd, eocd + eocdLen), pos);
  odv.setUint16(pos + 8, kept.length, true);
  odv.setUint16(pos + 10, kept.length, true);
  odv.setUint32(pos + 12, cdLen, true);
  odv.setUint32(pos + 16, cdStart, true);
  return out;
}

async function downloadReportPptx(report, projectName) {
  const PptxGenJS = await loadPptxGen();
  const pres = buildReportPptx(PptxGenJS, report, projectName);
  const safe = String(projectName || 'project').replace(/[^\w-]+/g, '_');
  const bytes = stripZipFolderEntries(await pres.write({ outputType: 'arraybuffer' }));
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safe + '_report_' + todayStr() + '.pptx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Loaded on demand so the (large) library is only downloaded when someone asks for a deck.
async function loadPptxGen() {
  const mod = await import('pptxgenjs');
  return mod.default || mod;
}

function ReportBarChart({ title, data, dataKey, signed }) {
  return (
    <div className="report-block" style={{ border: '1px solid #D9D2C2', borderRadius: 2, padding: 8, backgroundColor: 'white', maxWidth: '100%', overflowX: 'auto' }}>
      <p style={{ fontSize: 12, fontWeight: 600, color: '#4A453C', margin: '0 0 4px' }}>{title}</p>
      {data.length === 0 ? (
        <p style={{ fontSize: 11, color: '#8B8578', margin: 0 }}>Nothing logged yet.</p>
      ) : (
        <BarChart width={470} height={210} data={data} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#EEE8DA" />
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#8B8578' }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 9, fill: '#8B8578' }} allowDecimals={false} />
          <Bar dataKey={dataKey} fill="#3D6178" radius={[2, 2, 0, 0]} isAnimationActive={false} label={{ position: 'top', fontSize: 8, fill: '#4A453C' }}>
            {signed && data.map((d, i) => <Cell key={i} fill={d[dataKey] >= 0 ? '#4F7C52' : '#B5482F'} />)}
          </Bar>
        </BarChart>
      )}
    </div>
  );
}

function ReportStage({ exp, act }) {
  if (!exp && !act) return <span style={{ color: '#B7ADA0' }}>—</span>;
  const late = exp && act && act > exp;
  const overdueNow = exp && !act && exp < todayStr();
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div style={{ color: '#8B8578' }}>Exp {exp ? fmtDate(exp) : '—'}</div>
      <div style={{ color: late || overdueNow ? '#B5482F' : '#2A2620', fontWeight: act ? 600 : 400 }}>
        {act ? 'Act ' + fmtDate(act) : overdueNow ? 'Overdue' : 'Act —'}
      </div>
    </div>
  );
}

function ReportsPage({ projectName, activities, manpower, trades, procItems, procLots, procUpdates }) {
  const compute = () => buildReport({ activities, manpower, procItems, procLots, procUpdates, trades });
  const [report, setReport] = useState(compute);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const printRef = useRef(null);

  const refresh = () => { setReport(compute()); setMsg(''); };

  // Print (or save as PDF) just the report: copy it to the end of <body>, hide everything
  // else while printing, then remove the copy again.
  const handlePrint = () => {
    const src = printRef.current;
    if (!src) return;
    setMsg('');
    const holder = document.createElement('div');
    holder.className = 'report-print-root';
    holder.appendChild(src.cloneNode(true));
    document.body.appendChild(holder);
    const cleanup = () => {
      window.removeEventListener('afterprint', cleanup);
      if (holder.parentNode) holder.parentNode.removeChild(holder);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(cleanup, 120000);
    try {
      window.print();
    } catch (e) {
      cleanup();
      setMsg('Printing is not available in this window. Open the app in a normal browser tab to print or save as PDF.');
    }
  };

  const handleExcel = async () => {
    setBusy(true);
    setMsg('');
    try {
      await downloadReportXlsx(report, projectName);
    } catch (e) {
      setMsg('Could not create the Excel file here: ' + (e && e.message ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const [pptBusy, setPptBusy] = useState(false);
  const handlePpt = async () => {
    setPptBusy(true);
    setMsg('');
    try {
      await downloadReportPptx(report, projectName);
    } catch (e) {
      setMsg('Could not create the PowerPoint file: ' + (e && e.message ? e.message : e));
    } finally {
      setPptBusy(false);
    }
  };

  const { generatedAt, manpowerDaily, manpowerMonthly, latestDay, pendingActivities, activitySummary, pendingProcurement, procurementSummary } = report;
  const dailyChart = manpowerDaily.slice(-REPORT_DAILY_DAYS);
  const monthlyChart = manpowerMonthly.slice(-REPORT_MONTHS);
  const stamp = generatedAt.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const h2 = { fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 600, margin: '0 0 2px', color: '#1C2733' };
  const sub = { fontSize: 11, color: '#8B8578', margin: '0 0 10px' };
  const th = { padding: '4px 6px', fontWeight: 400, borderBottom: '1px solid #D9D2C2' };
  const td = { padding: '5px 6px', verticalAlign: 'top', borderBottom: '1px solid #EEE8DA' };

  return (
    <div className="space-y-4">
      <style>{`
        @media screen { .report-print-root { display: none; } }
        @media print {
          @page { size: A4 landscape; margin: 10mm; }
          body > *:not(.report-print-root) { display: none !important; }
          .report-print-root { display: block !important; }
          .report-print-root, .report-print-root * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .report-block { break-inside: avoid; page-break-inside: avoid; }
          .report-print-root tr { break-inside: avoid; page-break-inside: avoid; }
          .report-newpage { break-before: page; page-break-before: always; }
        }
      `}</style>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={refresh} className="text-sm border px-3 py-1.5 rounded-sm" style={{ color: '#3D6178', borderColor: '#3D6178' }}>
          Refresh report
        </button>
        <button onClick={handlePrint} className="flex items-center gap-1.5 text-white px-3 py-1.5 rounded-sm text-sm" style={{ backgroundColor: '#1C2733' }}>
          <Printer size={14} /> Print / Save as PDF
        </button>
        <button
          onClick={handleExcel} disabled={busy}
          className="flex items-center gap-1.5 text-white px-3 py-1.5 rounded-sm text-sm"
          style={{ backgroundColor: busy ? '#B7ADA0' : '#D98E2B' }}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Download Excel
        </button>
        <button
          onClick={handlePpt} disabled={pptBusy}
          className="flex items-center gap-1.5 text-white px-3 py-1.5 rounded-sm text-sm"
          style={{ backgroundColor: pptBusy ? '#B7ADA0' : '#3D6178' }}
        >
          {pptBusy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Download PowerPoint
        </button>
      </div>
      <p className="text-xs" style={{ color: '#8B8578' }}>
        This is a snapshot of the data as of {stamp}; use Refresh to take a new one. For a PDF, choose "Save as PDF" as the
        printer. The Excel file holds the data behind each section (charts can't be placed inside it); the PowerPoint has the charts, bars and tables as slides.
      </p>
      {msg && <p className="text-xs" style={{ color: '#B5482F' }}>{msg}</p>}

      <div className="tracker-card bg-white border rounded-sm p-4" style={{ borderColor: '#D9D2C2' }}>
        <div ref={printRef} style={{ fontFamily: "'Inter', sans-serif", color: '#2A2620', backgroundColor: 'white', width: '100%' }}>
          <div style={{ borderBottom: '3px solid #D98E2B', paddingBottom: 6, marginBottom: 14 }}>
            <p style={{ ...h2, fontSize: 26 }}>{projectName || 'Project'} — status report</p>
            <p style={{ fontSize: 11, color: '#8B8578', margin: 0 }}>Generated {stamp}</p>
          </div>

          <p style={h2}>1. Manpower</p>
          <p style={sub}>
            {latestDay
              ? 'Latest logged day ' + fmtDate(latestDay.date) + ': ' + latestDay.total + ' on site'
                + (Object.keys(latestDay.byDiscipline).length
                  ? ' (' + Object.entries(latestDay.byDiscipline).map(([d, n]) => d + ' ' + n).join(', ') + ')' : '') + '.'
              : 'No manpower has been logged yet.'}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <ReportBarChart title={'Daily manpower (last ' + dailyChart.length + ' logged days)'} data={dailyChart} dataKey="total" />
            <ReportBarChart title="Day-over-day change" data={dailyChart.filter(d => d.change !== null)} dataKey="change" signed />
            <ReportBarChart title={'Monthly manpower, man-days (last ' + monthlyChart.length + ' months)'} data={monthlyChart} dataKey="total" />
            <ReportBarChart title="Month-over-month change" data={monthlyChart.filter(d => d.change !== null)} dataKey="change" signed />
          </div>

          <div className="report-newpage" style={{ marginTop: 22 }}>
            <p style={h2}>2. Pending activities — completion</p>
            <p style={sub}>
              {activitySummary.pending} pending, {activitySummary.overdue} overdue
              {activitySummary.averagePct !== null ? '; average completion ' + activitySummary.averagePct + '% (where scope is tracked)' : ''}.
              Each bar is the share of the activity's total scope completed; "n/a" means no total scope was entered.
            </p>
            {pendingActivities.length === 0 && <p style={{ fontSize: 12, color: '#8B8578' }}>No pending activities.</p>}
            {pendingActivities.map((a, i) => (
              <div
                key={i} className="report-block"
                style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.3fr) minmax(0,2fr) 44px', gap: 10, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #EEE8DA' }}
              >
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontSize: 12, margin: 0, fontWeight: 500 }}>{a.name}</p>
                  <p style={{ fontSize: 10, margin: 0, color: '#8B8578' }}>
                    {[a.discipline, a.area].filter(Boolean).join(' · ')}{(a.discipline || a.area) ? ' · ' : ''}
                    <span style={{ color: CATEGORY_COLORS[a.status] || '#8B8578', fontWeight: 600 }}>{a.status}</span>
                    {a.delayDays > 0 ? ' · ' + a.delayDays + 'd late' : ''}
                    {a.plannedEnd ? ' · due ' + fmtDate(a.plannedEnd) : ''}
                  </p>
                </div>
                <div style={{ height: 14, backgroundColor: '#EEE8DA', borderRadius: 2 }}>
                  <div style={{ width: (a.pct === null ? 0 : a.pct) + '%', height: '100%', backgroundColor: CATEGORY_COLORS[a.status] || '#3D6178', borderRadius: 2 }} />
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, textAlign: 'right' }}>{a.pct === null ? 'n/a' : a.pct + '%'}</div>
              </div>
            ))}
          </div>

          <div className="report-newpage" style={{ marginTop: 22 }}>
            <p style={h2}>3. Pending procurement</p>
            <p style={sub}>
              {procurementSummary.pendingLots} lot{procurementSummary.pendingLots === 1 ? '' : 's'} not yet delivered across{' '}
              {procurementSummary.itemsWithPendingLots} item{procurementSummary.itemsWithPendingLots === 1 ? '' : 's'}
              {procurementSummary.overdueLots ? ', ' + procurementSummary.overdueLots + ' overdue' : ''}
              {procurementSummary.itemsWithNoLots ? '; ' + procurementSummary.itemsWithNoLots + ' item' + (procurementSummary.itemsWithNoLots === 1 ? '' : 's') + ' with no lots recorded yet' : ''}.
              Dates show expected (Exp) against actual (Act).
            </p>
            {pendingProcurement.length === 0 ? (
              <p style={{ fontSize: 12, color: '#8B8578' }}>Nothing pending — every lot has been delivered.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#8B8578' }}>
                    <th style={th}>Item</th>
                    <th style={th}>Lot</th>
                    <th style={th}>Status</th>
                    {PROC_STAGES.map(s => <th key={s.key} style={th}>{s.label}</th>)}
                    <th style={th}>Latest update</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingProcurement.map((r, i) => (
                    <tr key={i}>
                      <td style={td}>
                        <div style={{ fontWeight: 600, fontSize: 11 }}>{r.item}</div>
                        <div style={{ color: '#8B8578' }}>{[r.discipline, r.supplier].filter(Boolean).join(' · ') || '—'}</div>
                      </td>
                      <td style={td}>
                        {r.lotNo ? (
                          <div>
                            <div style={{ fontWeight: 600 }}>Lot {r.lotNo}</div>
                            <div style={{ color: '#8B8578' }}>{r.quantity !== '' ? 'Qty ' + r.quantity : ''}</div>
                            <div style={{ color: '#8B8578' }}>{r.location}</div>
                          </div>
                        ) : <span style={{ color: '#B7ADA0' }}>—</span>}
                      </td>
                      <td style={{ ...td, color: r.statusColor, fontWeight: 600 }}>{r.status}</td>
                      {PROC_STAGES.map((s, si) => (
                        <td key={s.key} style={td}>
                          {r.stages[si] ? <ReportStage exp={r.stages[si].expected} act={r.stages[si].actual} /> : <span style={{ color: '#B7ADA0' }}>—</span>}
                        </td>
                      ))}
                      <td style={td}>
                        {r.latestUpdate ? (
                          <div>
                            <div style={{ color: '#8B8578' }}>{fmtDate(r.latestUpdate.date)}</div>
                            <div>{r.latestUpdate.description}</div>
                          </div>
                        ) : <span style={{ color: '#B7ADA0' }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Timeline ---------------- */
function laterOf(a, b) { if (!a) return b; if (!b) return a; return a > b ? a : b; }
function earlierOf(a, b) { if (!a) return b; if (!b) return a; return a < b ? a : b; }

function TimelinePage({ activities, procItems, procLots, areas, trades }) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [subView, setSubView] = useState('activities');
  const [selectedStages, setSelectedStages] = useState(PROC_STAGES.map(s => s.key));
  const [filter, setFilter] = useState('All');
  const [areaFilter, setAreaFilter] = useState('All');
  const [disciplineFilter, setDisciplineFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [startFrom, setStartFrom] = useState('');
  const [startTo, setStartTo] = useState('');
  const [finishFrom, setFinishFrom] = useState('');
  const [finishTo, setFinishTo] = useState('');

  const filteredActivities = useMemo(() => {
    let list = [...activities];
    if (filter !== 'All') list = list.filter(a => scheduleCategory(a) === filter);
    if (areaFilter !== 'All') list = list.filter(a => (a.area || 'Unassigned') === areaFilter);
    if (disciplineFilter !== 'All') list = list.filter(a => (a.category || 'Unassigned') === disciplineFilter);
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(a => a.name.toLowerCase().includes(q));
    }
    if (startFrom) list = list.filter(a => a.plannedStart && a.plannedStart >= startFrom);
    if (startTo) list = list.filter(a => a.plannedStart && a.plannedStart <= startTo);
    if (finishFrom) list = list.filter(a => a.plannedEnd && a.plannedEnd >= finishFrom);
    if (finishTo) list = list.filter(a => a.plannedEnd && a.plannedEnd <= finishTo);
    return list;
  }, [activities, filter, areaFilter, disciplineFilter, searchQuery, startFrom, startTo, finishFrom, finishTo]);

  const hasActiveFilters = filter !== 'All' || areaFilter !== 'All' || disciplineFilter !== 'All'
    || searchQuery || startFrom || startTo || finishFrom || finishTo;
  const clearAllFilters = () => {
    setFilter('All'); setAreaFilter('All'); setDisciplineFilter('All'); setSearchQuery('');
    setStartFrom(''); setStartTo(''); setFinishFrom(''); setFinishTo('');
  };

  const toggleStage = (key) => {
    setSelectedStages(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const daysInMonth = new Date(cursor.year, cursor.month + 1, 0).getDate();
  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const todayDate = new Date();
  const isCurrentMonth = todayDate.getFullYear() === cursor.year && todayDate.getMonth() === cursor.month;
  const todayDay = todayDate.getDate();
  const today = todayStr();
  const dayWidth = 30;

  const monthOverlap = (startStr, endStr) => {
    if (!startStr || !endStr) return null;
    const s = new Date(startStr + 'T00:00:00');
    const e = new Date(endStr + 'T00:00:00');
    const monthStart = new Date(cursor.year, cursor.month, 1);
    const monthEnd = new Date(cursor.year, cursor.month, daysInMonth);
    const os = s < monthStart ? monthStart : s;
    const oe = e > monthEnd ? monthEnd : e;
    if (os > oe) return null;
    return { start: os.getDate(), end: oe.getDate() };
  };

  const rows = useMemo(() => {
    return filteredActivities.map(a => {
      const plannedBar = monthOverlap(a.plannedStart, a.plannedEnd);
      const actualEndForBar = a.actualEnd || (a.actualStart && !isDone(a) ? today : a.actualStart);
      const onTimeEnd = earlierOf(actualEndForBar, a.plannedEnd) || actualEndForBar;
      const onTimeBar = a.actualStart ? monthOverlap(a.actualStart, onTimeEnd) : null;
      const hasDateDelay = a.plannedEnd && actualEndForBar && actualEndForBar > a.plannedEnd;
      const delayBar = hasDateDelay ? monthOverlap(laterOf(a.plannedEnd, a.actualStart), actualEndForBar) : null;
      const kind = overdueKind(a);
      // Not started and past its planned start: hatch from the planned start to today.
      const notStartedDelayBar = kind === 'notStarted' ? monthOverlap(a.plannedStart || a.plannedEnd, today) : null;
      const delayDays = a.actualEnd && a.plannedEnd && a.actualEnd > a.plannedEnd
        ? daysBetween(a.plannedEnd, a.actualEnd)
        : (kind === 'notStarted' ? daysBetween(a.plannedStart || a.plannedEnd, today)
          : (kind === 'delayed' ? daysBetween(a.plannedEnd, today) : 0));
      const pct = percentComplete(a);
      const visible = plannedBar || onTimeBar || delayBar || notStartedDelayBar;
      return { a, plannedBar, onTimeBar, delayBar, notStartedDelayBar, delayDays, pct, visible };
    }).filter(r => r.visible);
  }, [filteredActivities, cursor, today]);

  const unscheduled = filteredActivities.filter(a => !a.plannedStart || !a.plannedEnd);

  const procRows = useMemo(() => {
    return procLots.map(lot => {
      const item = procItems.find(i => i.id === lot.itemId);
      const stageBars = PROC_STAGES
        .filter(s => selectedStages.includes(s.key))
        .map(s => {
          const exp = lot[s.exp];
          const act = lot[s.act];
          let start = null, end = null, delayed = false;
          if (act) {
            start = exp ? earlierOf(exp, act) : act;
            end = exp ? laterOf(exp, act) : act;
            delayed = !!(exp && act > exp);
          } else if (exp && exp < today) {
            start = exp; end = today; delayed = true;
          }
          if (!start || !end) return null;
          const bar = monthOverlap(start, end);
          if (!bar) return null;
          return { key: s.key, label: s.label, bar, delayed };
        })
        .filter(Boolean);
      return { lot, item, stageBars };
    }).filter(r => r.stageBars.length > 0);
  }, [procLots, procItems, cursor, selectedStages, today]);

  const shiftMonth = (delta) => {
    let m = cursor.month + delta;
    let y = cursor.year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setCursor({ year: y, month: m });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>{monthLabel}</h2>
        <div className="flex gap-1">
          <button onClick={() => shiftMonth(-1)} className="border rounded-sm p-1.5 bg-white" style={{ borderColor: '#D9D2C2' }}><ChevronLeft size={16} /></button>
          <button onClick={() => shiftMonth(1)} className="border rounded-sm p-1.5 bg-white" style={{ borderColor: '#D9D2C2' }}><ChevronRight size={16} /></button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {[{ id: 'activities', label: 'Activities' }, { id: 'procurement', label: 'Procurement' }].map(t => (
          <button
            key={t.id}
            onClick={() => setSubView(t.id)}
            className="px-3 py-1.5 text-xs rounded-sm border"
            style={{
              background: subView === t.id ? '#1C2733' : 'white',
              color: subView === t.id ? 'white' : '#4A453C',
              borderColor: subView === t.id ? '#1C2733' : '#D9D2C2',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subView === 'procurement' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs" style={{ color: '#8B8578' }}>Show stages:</span>
          {PROC_STAGES.map(s => (
            <button
              key={s.key}
              onClick={() => toggleStage(s.key)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-sm border"
              style={{
                borderColor: selectedStages.includes(s.key) ? STAGE_COLORS[s.key] : '#D9D2C2',
                color: selectedStages.includes(s.key) ? '#2A2620' : '#8B8578',
                background: selectedStages.includes(s.key) ? STAGE_COLORS[s.key] + '1A' : 'white',
              }}
            >
              <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: STAGE_COLORS[s.key] }} />
              {s.label}
            </button>
          ))}
        </div>
      )}

      {subView === 'activities' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1">
            {['All', ...CATEGORY_LIST].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className="px-2.5 py-1 text-xs rounded-sm whitespace-nowrap border"
                style={{
                  background: filter === f ? '#1C2733' : 'white',
                  color: filter === f ? 'white' : '#4A453C',
                  borderColor: filter === f ? '#1C2733' : '#D9D2C2',
                }}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Area</label>
              <select
                value={areaFilter}
                onChange={(e) => setAreaFilter(e.target.value)}
                className="border rounded-sm px-2 py-1.5 text-sm bg-white" style={{ borderColor: '#D9D2C2' }}
              >
                <option value="All">All areas</option>
                {areas.map(ar => <option key={ar} value={ar}>{ar}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Discipline</label>
              <select
                value={disciplineFilter}
                onChange={(e) => setDisciplineFilter(e.target.value)}
                className="border rounded-sm px-2 py-1.5 text-sm bg-white" style={{ borderColor: '#D9D2C2' }}
              >
                <option value="All">All disciplines</option>
                {trades.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="flex-1" style={{ minWidth: 160 }}>
              <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Search</label>
              <input
                list="timeline-activity-suggestions"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search activity description..."
                className="w-full border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }}
              />
              <datalist id="timeline-activity-suggestions">
                {Array.from(new Set(activities.map(a => a.name))).map(n => <option key={n} value={n} />)}
              </datalist>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex items-end gap-2">
              <div>
                <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Planned start from</label>
                <input type="date" value={startFrom} onChange={(e) => setStartFrom(e.target.value)} className="border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }} />
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>to</label>
                <input type="date" value={startTo} onChange={(e) => setStartTo(e.target.value)} className="border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }} />
              </div>
            </div>
            <div className="flex items-end gap-2">
              <div>
                <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>Planned finish from</label>
                <input type="date" value={finishFrom} onChange={(e) => setFinishFrom(e.target.value)} className="border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }} />
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: '#8B8578' }}>to</label>
                <input type="date" value={finishTo} onChange={(e) => setFinishTo(e.target.value)} className="border rounded-sm px-2 py-1.5 text-sm" style={{ borderColor: '#D9D2C2' }} />
              </div>
            </div>
            {hasActiveFilters && (
              <button onClick={clearAllFilters} className="text-xs underline" style={{ color: '#3D6178' }}>
                Clear filters
              </button>
            )}
          </div>
        </div>
      )}

      {subView === 'activities' && (
      <>
      {rows.length === 0 ? (
        <div className="tracker-card bg-white border rounded-sm p-4" style={{ borderColor: '#D9D2C2' }}>
          <p className="text-sm" style={{ color: '#8B8578' }}>
            {hasActiveFilters ? 'No activities match the current filters within ' : 'No activities scheduled within '}{monthLabel}.
          </p>
        </div>
      ) : (
        <div className="tracker-card bg-white border rounded-sm overflow-hidden flex" style={{ borderColor: '#D9D2C2' }}>
          <div className="w-32 shrink-0 border-r" style={{ borderColor: '#D9D2C2' }}>
            <div className="h-9 border-b flex items-center px-2 text-xs" style={{ borderColor: '#D9D2C2', color: '#8B8578' }}>Activity</div>
            {rows.map(({ a, delayDays, pct }) => (
              <div key={a.id} className="h-12 border-b last:border-b-0 flex flex-col justify-center px-2" style={{ borderColor: '#EEE8DA' }} title={a.name}>
                <span className="text-xs truncate">{a.name}</span>
                <span className="text-[10px] flex items-center gap-1.5" style={{ color: '#8B8578' }}>
                  {pct !== null && <span>{pct}%</span>}
                  {delayDays > 0 && <span style={{ color: '#B5482F' }}>{delayDays}d delay</span>}
                </span>
              </div>
            ))}
          </div>
          <div className="overflow-x-auto flex-1">
            <div style={{ minWidth: daysInMonth * dayWidth }}>
              <div className="flex h-9 border-b" style={{ borderColor: '#D9D2C2' }}>
                {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(d => (
                  <div
                    key={d}
                    className="shrink-0 flex items-center justify-center text-[10px]"
                    style={{ color: '#8B8578', width: dayWidth, background: isCurrentMonth && d === todayDay ? '#EADFC5' : 'transparent' }}
                  >
                    {d}
                  </div>
                ))}
              </div>
              {rows.map(({ a, plannedBar, onTimeBar, delayBar, notStartedDelayBar }) => {
                const statusColor = CATEGORY_COLORS[scheduleCategory(a)];
                return (
                  <div key={a.id} className="relative h-12 border-b last:border-b-0" style={{ borderColor: '#EEE8DA', width: daysInMonth * dayWidth }}>
                    {isCurrentMonth && (
                      <div className="absolute top-0 bottom-0 w-px" style={{ backgroundColor: '#D9A94F', left: (todayDay - 1) * dayWidth + dayWidth / 2, zIndex: 1 }} />
                    )}
                    {plannedBar && (
                      <div
                        className="absolute top-1.5 h-2.5 rounded-sm border"
                        style={{
                          left: (plannedBar.start - 1) * dayWidth + 2,
                          width: (plannedBar.end - plannedBar.start + 1) * dayWidth - 4,
                          borderColor: '#3D6178',
                          background: '#3D617822',
                        }}
                        title={`Planned: ${fmtDate(a.plannedStart)} to ${fmtDate(a.plannedEnd)}`}
                      />
                    )}
                    {onTimeBar && (
                      <div
                        className="absolute top-6 h-3.5 rounded-sm"
                        style={{
                          left: (onTimeBar.start - 1) * dayWidth + 2,
                          width: (onTimeBar.end - onTimeBar.start + 1) * dayWidth - (delayBar ? 0 : 4),
                          background: statusColor,
                        }}
                        title={`Actual: ${fmtDate(a.actualStart)} to ${fmtDate(a.actualEnd || today)}`}
                      />
                    )}
                    {delayBar && (
                      <div
                        className="absolute top-6 h-3.5 rounded-sm"
                        style={{
                          left: (delayBar.start - 1) * dayWidth,
                          width: (delayBar.end - delayBar.start + 1) * dayWidth - 4,
                          background: '#B5482F',
                          backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.25) 0, rgba(255,255,255,0.25) 3px, transparent 3px, transparent 6px)',
                        }}
                        title={`Delay: running past planned finish (${fmtDate(a.plannedEnd)})`}
                      />
                    )}
                    {notStartedDelayBar && (
                      <div
                        className="absolute top-6 h-3.5 rounded-sm"
                        style={{
                          left: (notStartedDelayBar.start - 1) * dayWidth + 2,
                          width: (notStartedDelayBar.end - notStartedDelayBar.start + 1) * dayWidth - 4,
                          background: '#B5482F',
                          backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.25) 0, rgba(255,255,255,0.25) 3px, transparent 3px, transparent 6px)',
                        }}
                        title={`Not started — overdue since ${fmtDate(a.plannedEnd)}`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 text-xs" style={{ color: '#8B8578' }}>
        <div className="flex items-center gap-1.5">
          <span className="w-4 h-2.5 rounded-sm inline-block border" style={{ borderColor: '#3D6178', background: '#3D617822' }} />
          Planned
        </div>
        {CATEGORY_LIST.map(label => (
          <div key={label} className="flex items-center gap-1.5">
            <span className="w-4 h-2.5 rounded-sm inline-block" style={{ background: CATEGORY_COLORS[label] }} />
            {label}
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <span className="w-4 h-2.5 rounded-sm inline-block" style={{ background: '#B5482F', backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.25) 0, rgba(255,255,255,0.25) 2px, transparent 2px, transparent 4px)' }} />
          Delay overrun
        </div>
      </div>

      {unscheduled.length > 0 && (
        <div className="tracker-card bg-white border rounded-sm p-4" style={{ borderColor: '#D9D2C2' }}>
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5" style={{ color: '#4A453C' }}>
            <AlertTriangle size={14} style={{ color: '#D98E2B' }} /> Not yet scheduled
          </h3>
          <ul className="space-y-1">
            {unscheduled.map(a => (
              <li key={a.id} className="text-sm" style={{ color: '#4A453C' }}>{a.name}</li>
            ))}
          </ul>
        </div>
      )}
      </>
      )}

      {subView === 'procurement' && (
        <>
          {selectedStages.length === 0 ? (
            <div className="tracker-card bg-white border rounded-sm p-4" style={{ borderColor: '#D9D2C2' }}>
              <p className="text-sm" style={{ color: '#8B8578' }}>Select at least one stage above to visualize.</p>
            </div>
          ) : procRows.length === 0 ? (
            <div className="tracker-card bg-white border rounded-sm p-4" style={{ borderColor: '#D9D2C2' }}>
              <p className="text-sm" style={{ color: '#8B8578' }}>No procurement activity for the selected stage(s) within {monthLabel}.</p>
            </div>
          ) : (
            <div className="tracker-card bg-white border rounded-sm overflow-hidden flex" style={{ borderColor: '#D9D2C2' }}>
              <div className="w-32 shrink-0 border-r" style={{ borderColor: '#D9D2C2' }}>
                <div className="h-9 border-b flex items-center px-2 text-xs" style={{ borderColor: '#D9D2C2', color: '#8B8578' }}>Item / Lot</div>
                {procRows.map(({ lot, item }) => (
                  <div key={lot.id} className="border-b last:border-b-0 flex flex-col justify-center px-2" style={{ borderColor: '#EEE8DA', height: 64 }} title={item ? item.name : ''}>
                    <span className="text-xs truncate">{item ? item.name : 'Unknown item'}</span>
                    <span className="text-[10px]" style={{ color: '#8B8578' }}>Lot {lot.lotNo}{lot.quantity !== '' && lot.quantity != null ? ` · Qty ${lot.quantity}` : ''}</span>
                  </div>
                ))}
              </div>
              <div className="overflow-x-auto flex-1">
                <div style={{ minWidth: daysInMonth * dayWidth }}>
                  <div className="flex h-9 border-b" style={{ borderColor: '#D9D2C2' }}>
                    {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(d => (
                      <div
                        key={d}
                        className="shrink-0 flex items-center justify-center text-[10px]"
                        style={{ color: '#8B8578', width: dayWidth, background: isCurrentMonth && d === todayDay ? '#EADFC5' : 'transparent' }}
                      >
                        {d}
                      </div>
                    ))}
                  </div>
                  {procRows.map(({ lot, stageBars }) => (
                    <div key={lot.id} className="relative border-b last:border-b-0" style={{ borderColor: '#EEE8DA', width: daysInMonth * dayWidth, height: 64 }}>
                      {isCurrentMonth && (
                        <div className="absolute top-0 bottom-0 w-px" style={{ backgroundColor: '#D9A94F', left: (todayDay - 1) * dayWidth + dayWidth / 2, zIndex: 1 }} />
                      )}
                      {stageBars.map(sb => {
                        const stageIndex = PROC_STAGES.findIndex(s => s.key === sb.key);
                        return (
                          <div
                            key={sb.key}
                            className="absolute rounded-sm"
                            style={{
                              top: 4 + stageIndex * 15,
                              height: 11,
                              left: (sb.bar.start - 1) * dayWidth + 2,
                              width: (sb.bar.end - sb.bar.start + 1) * dayWidth - 4,
                              background: STAGE_COLORS[sb.key],
                              backgroundImage: sb.delayed
                                ? 'repeating-linear-gradient(45deg, rgba(181,72,47,0.55) 0, rgba(181,72,47,0.55) 3px, transparent 3px, transparent 6px)'
                                : 'none',
                            }}
                            title={`${sb.label}${sb.delayed ? ' (delayed)' : ''}`}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-4 text-xs" style={{ color: '#8B8578' }}>
            {PROC_STAGES.map(s => (
              <div key={s.key} className="flex items-center gap-1.5">
                <span className="w-4 h-2.5 rounded-sm inline-block" style={{ background: STAGE_COLORS[s.key] }} />
                {s.label}
              </div>
            ))}
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-2.5 rounded-sm inline-block" style={{ background: '#8B8578', backgroundImage: 'repeating-linear-gradient(45deg, rgba(181,72,47,0.55) 0, rgba(181,72,47,0.55) 2px, transparent 2px, transparent 4px)' }} />
              Delayed
            </div>
          </div>
        </>
      )}
    </div>
  );
}

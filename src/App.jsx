import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase } from './supabaseClient';
import {
  LayoutDashboard, Users, ClipboardList, CalendarDays, Plus, Trash2,
  Pencil, Check, X, AlertTriangle, ChevronLeft, ChevronRight, Loader2,
  ChevronDown, Save, ListChecks, Package, FileText
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell
} from 'recharts';

const DEFAULT_TRADES = ['Piping', 'Civil', 'Mechanical', 'Electrical', 'Instrumentation'];
const STATUS_ORDER = ['Pending', 'In Progress', 'Completed'];
const STATUS_COLORS = { Pending: '#3D6178', 'In Progress': '#D98E2B', Completed: '#4F7C52', Overdue: '#B5482F' };
const PRIORITY_COLORS = { High: '#B5482F', Medium: '#D98E2B', Low: '#70796E' };

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
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
function isOverdue(activity) {
  return activity.plannedEnd && !isDone(activity) && activity.plannedEnd < todayStr();
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
  'Planned and progressing as per plan': '#3D6178',
  'Completed as per Plan': '#4F7C52',
  'Completed with delay': '#8A7F3D',
  'Overdue not started': '#7A2E1F',
  'Overdue with delay': '#B5482F',
};
const CATEGORY_LIST = Object.keys(CATEGORY_COLORS);

function scheduleCategory(a) {
  const today = todayStr();
  if (isDone(a)) {
    if (a.actualEnd && a.plannedEnd) {
      return a.actualEnd > a.plannedEnd ? 'Completed with delay' : 'Completed as per Plan';
    }
    return 'Completed as per Plan';
  }
  const overdue = a.plannedEnd && a.plannedEnd < today;
  if (overdue) {
    return a.actualStart ? 'Overdue with delay' : 'Overdue not started';
  }
  return 'Planned and progressing as per plan';
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
function toDateStr(v) {
  if (!v) return '';
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const d = new Date(String(v).trim());
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
  'trades-config', 'areas-config', 'manpower-entries', 'activities', 'daily-log-entries',
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
      <div className="w-full min-h-[600px] flex items-center justify-center p-4" style={{ backgroundColor: '#1C2733', fontFamily: "'Inter', sans-serif" }}>
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
    <div className="w-full min-h-[600px] flex items-center justify-center p-4" style={{ backgroundColor: '#1C2733', fontFamily: "'Inter', sans-serif" }}>
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
    <div className="w-full min-h-[600px] flex items-center justify-center p-4" style={{ backgroundColor: '#1C2733', fontFamily: "'Inter', sans-serif" }}>
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
    if (!session) { setProfile(null); return; }
    let cancelled = false;
    setProfileLoading(true);
    (async () => {
      const { data } = await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
      if (!cancelled) { setProfile(data || null); setProfileLoading(false); }
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
      const [tr, ar, mp, act, dl, dsa, pi, pl, pu, mr] = await Promise.all([
        safeGet(`trades-config:${suf}`),
        safeGet(`areas-config:${suf}`),
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
  // in the Daily Log. Only applies to activities that have a Total Scope set. Runs after data
  // for the active project has finished loading, and only writes when a value actually changed.
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
      const loggedActual = actualByActivity[a.id] || 0;
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

  if (profileLoading || !profile) {
    return (
      <div className="w-full h-full min-h-[500px] flex items-center justify-center" style={{backgroundColor: '#F1EDE4'}}>
        <Loader2 className="animate-spin" style={{color: '#3D6178'}} size={28} />
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
    <div className="w-full min-h-[600px]" style={{ backgroundColor: '#F1EDE4', color: '#2A2620', fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        input[type="date"]::-webkit-calendar-picker-indicator { cursor: pointer; }
      `}</style>

      {/* Header */}
      <div className="px-4 py-3 flex items-center justify-between" style={{backgroundColor: '#1C2733', color: '#F1EDE4'}}>
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
          { id: 'timeline', label: 'Timeline', icon: CalendarDays },
        ].map(t => {
          const Icon = t.icon;
          const active = view === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setView(t.id)}
              className="flex items-center gap-1.5 px-4 py-2.5 text-sm whitespace-nowrap border-b-2 transition-colors"
              style={{
                borderColor: active ? '#D98E2B' : 'transparent',
                color: active ? '#F1EDE4' : '#8FA3B3',
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
            activities={activities}
            overdueCount={overdueCount}
            pendingCount={pendingCount}
            progressCount={progressCount}
            completedCount={completedCount}
            goTo={setView}
          />
        )}
        {view === 'manpower' && (
          <ManpowerPage manpower={manpower} trades={trades} saveManpower={saveManpower} saveTrades={saveTrades} />
        )}
        {view === 'activities' && (
          <ActivitiesPage activities={activities} saveActivities={saveActivities} trades={trades} areas={areas} saveAreas={saveAreas} />
        )}
        {view === 'dailylog' && (
          <DailyLogPage
            activities={activities} manpower={manpower} dailyLog={dailyLog} saveDailyLog={saveDailyLog}
            subActivities={dailySubActivities} saveSubActivities={saveDailySubActivities} areas={areas}
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
        {view === 'timeline' && (
          <TimelinePage activities={activities} procItems={procItems} procLots={procLots} />
        )}
        {view === 'admin' && profile?.is_admin && (
          <AdminPage currentUserId={session.user.id} />
        )}
      </div>
    </div>
  );
}

/* ---------------- Dashboard ---------------- */
function Dashboard({ manpower, trades, activities, overdueCount, pendingCount, progressCount, completedCount, goTo }) {
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
        <div className="bg-white border rounded-sm p-4" style={{borderColor: '#D9D2C2'}}>
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

        <div className="bg-white border rounded-sm p-4" style={{borderColor: '#D9D2C2'}}>
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

      <ManpowerTrackerCard manpower={manpower} />
    </div>
  );
}

/* ---------------- Manpower tracker (dashboard) ---------------- */
function ManpowerTrackerCard({ manpower }) {
  const [mode, setMode] = useState('daily');

  const dailyData = useMemo(() => {
    return Object.keys(manpower).sort().map(d => ({
      date: d,
      label: fmtDateShort(d),
      total: Object.values(manpower[d].trades || {}).reduce((a, b) => a + Number(b || 0), 0),
    }));
  }, [manpower]);

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
    <div className="bg-white border rounded-sm p-4" style={{borderColor: '#D9D2C2'}}>
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
function ManpowerPage({ manpower, trades, saveManpower, saveTrades }) {
  const [date, setDate] = useState(todayStr());
  const entry = manpower[date] || { trades: {}, notes: '' };
  const [counts, setCounts] = useState(entry.trades || {});
  const [notes, setNotes] = useState(entry.notes || '');
  const [newTrade, setNewTrade] = useState('');

  useEffect(() => {
    const e = manpower[date] || { trades: {}, notes: '' };
    setCounts(e.trades || {});
    setNotes(e.notes || '');
  }, [date, manpower]);

  const total = Object.values(counts).reduce((a, b) => a + Number(b || 0), 0);

  const handleSave = () => {
    const updated = { ...manpower, [date]: { trades: counts, notes, updatedAt: new Date().toISOString() } };
    saveManpower(updated);
  };

  const addTrade = () => {
    const name = newTrade.trim();
    if (!name || trades.includes(name)) return;
    saveTrades([...trades, name]);
    setNewTrade('');
  };

  const history = useMemo(() => {
    return Object.keys(manpower).sort().reverse().slice(0, 14).map(d => ({
      date: d,
      total: Object.values(manpower[d].trades || {}).reduce((a, b) => a + Number(b || 0), 0),
    }));
  }, [manpower]);

  return (
    <div className="space-y-5">
      <div className="bg-white border rounded-sm p-4" style={{borderColor: '#D9D2C2'}}>
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

        <table className="w-full text-sm mb-3">
          <tbody>
            {trades.map(trade => (
              <tr key={trade} className="border-b last:border-b-0 group" style={{borderColor: '#EEE8DA'}}>
                <td className="py-2 w-1/2" style={{color: '#4A453C'}}>{trade}</td>
                <td className="py-2">
                  <div className="flex items-center justify-end gap-2">
                    <input
                      type="number"
                      min="0"
                      value={counts[trade] ?? ''}
                      placeholder="0"
                      onChange={(e) => setCounts({ ...counts, [trade]: e.target.value })}
                      className="w-24 border rounded-sm px-2 py-1 text-right" style={{borderColor: '#D9D2C2'}}
                    />
                    <Trash2
                      size={14}
                      className="cursor-pointer" style={{ color: '#C4BCA8' }}
                      onClick={() => saveTrades(trades.filter(t => t !== trade))}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

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

      <div className="bg-white border rounded-sm p-4" style={{borderColor: '#D9D2C2'}}>
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
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
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
    return list.sort((a, b) => {
      if (!a.plannedEnd) return 1;
      if (!b.plannedEnd) return -1;
      return a.plannedEnd < b.plannedEnd ? -1 : 1;
    });
  }, [activities, filter, areaFilter]);

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

      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-xs mr-1" style={{ color: '#8B8578' }}>Area:</span>
        {['All', ...areas].map(ar => (
          <button
            key={ar}
            onClick={() => setAreaFilter(ar)}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-sm whitespace-nowrap border"
            style={{
              background: areaFilter === ar ? '#3D6178' : 'white',
              color: areaFilter === ar ? 'white' : '#4A453C',
              borderColor: areaFilter === ar ? '#3D6178' : '#D9D2C2',
            }}
          >
            <span onClick={() => setAreaFilter(ar)}>{ar}</span>
            {ar !== 'All' && (
              <X
                size={11}
                onClick={(ev) => { ev.stopPropagation(); removeArea(ar); }}
                style={{ color: areaFilter === ar ? '#F1EDE4' : '#B7ADA0' }}
              />
            )}
          </button>
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
        <div className="bg-white border rounded-sm p-4 space-y-3" style={{borderColor: '#D9D2C2'}}>
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

      <div className="bg-white border rounded-sm overflow-hidden" style={{borderColor: '#D9D2C2'}}>
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
const emptyLogForm = { date: todayStr(), activityId: '', plannedQty: '', actualQty: '', manpower: '' };

function dayTotalForDiscipline(manpower, date, discipline) {
  if (!discipline) return null;
  const entry = manpower[date];
  if (!entry) return 0;
  return Number(entry.trades?.[discipline] || 0);
}

const emptySubForm = { description: '', manpower: '' };

function DailyLogPage({ activities, manpower, dailyLog, saveDailyLog, subActivities, saveSubActivities, areas }) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyLogForm);
  const [expandedId, setExpandedId] = useState(null);
  const [subFormEntryId, setSubFormEntryId] = useState(null);
  const [editingSubId, setEditingSubId] = useState(null);
  const [subForm, setSubForm] = useState(emptySubForm);
  const [areaFilter, setAreaFilter] = useState('All');

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
    setForm({ date: e.date, activityId: e.activityId, plannedQty: e.plannedQty ?? '', actualQty: e.actualQty ?? '', manpower: e.manpower ?? '' });
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
    return list.sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [dailyLog, areaFilter, activityById]);

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
    setSubForm({ description: s.description || '', manpower: s.manpower ?? '' });
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

      {activities.length === 0 && (
        <p className="text-sm" style={{ color: '#8B8578' }}>Add activities in the Activities tab first, then log daily progress against them here.</p>
      )}

      {showForm && (
        <div className="bg-white border rounded-sm p-4 space-y-3" style={{ borderColor: '#D9D2C2' }}>
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
        <div className="bg-white border rounded-sm p-4" style={{ borderColor: '#D9D2C2' }}>
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
              <div key={e.id} className="bg-white border rounded-sm overflow-hidden" style={{ borderColor: '#D9D2C2' }}>
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
                          <p className="text-xs" style={{ color: '#8B8578' }}>Manpower: {s.manpower || 0}</p>
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
        <div className="bg-white border rounded-sm p-4 space-y-3" style={{ borderColor: '#D9D2C2' }}>
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
        <div className="bg-white border rounded-sm p-4" style={{ borderColor: '#D9D2C2' }}>
          <p className="text-sm" style={{ color: '#8B8578' }}>No procurement items yet. Add one to start tracking lots against it.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(item => {
            const itemLots = lots.filter(l => l.itemId === item.id);
            const expanded = expandedId === item.id;
            return (
              <div key={item.id} className="bg-white border rounded-sm overflow-hidden" style={{ borderColor: '#D9D2C2' }}>
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
                        <div key={lot.id} className="bg-white border rounded-sm p-3" style={{ borderColor: '#D9D2C2' }}>
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
                      <div className="bg-white border rounded-sm p-3 space-y-3" style={{ borderColor: '#3D6178' }}>
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
        <div className="bg-white border rounded-sm p-4 space-y-3" style={{ borderColor: '#D9D2C2' }}>
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
        <div className="bg-white border rounded-sm p-3" style={{ borderColor: '#3D6178' }}>
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
        <div className="bg-white border rounded-sm p-4" style={{ borderColor: '#D9D2C2' }}>
          <p className="text-sm" style={{ color: '#8B8578' }}>No meeting records yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map(rec => (
            <div key={rec.id} className="bg-white border rounded-sm overflow-hidden" style={{ borderColor: '#D9D2C2' }}>
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
          <div className="bg-white border rounded-sm overflow-hidden" style={{ borderColor: '#D9D2C2' }}>
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

          <div className="bg-white border rounded-sm overflow-hidden" style={{ borderColor: '#D9D2C2' }}>
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

/* ---------------- Timeline ---------------- */
function laterOf(a, b) { if (!a) return b; if (!b) return a; return a > b ? a : b; }
function earlierOf(a, b) { if (!a) return b; if (!b) return a; return a < b ? a : b; }

function TimelinePage({ activities, procItems, procLots }) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [subView, setSubView] = useState('activities');
  const [selectedStages, setSelectedStages] = useState(PROC_STAGES.map(s => s.key));

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
    return activities.map(a => {
      const plannedBar = monthOverlap(a.plannedStart, a.plannedEnd);
      const actualEndForBar = a.actualEnd || (a.actualStart && !isDone(a) ? today : a.actualStart);
      const onTimeEnd = earlierOf(actualEndForBar, a.plannedEnd) || actualEndForBar;
      const onTimeBar = a.actualStart ? monthOverlap(a.actualStart, onTimeEnd) : null;
      const hasDateDelay = a.plannedEnd && actualEndForBar && actualEndForBar > a.plannedEnd;
      const delayBar = hasDateDelay ? monthOverlap(laterOf(a.plannedEnd, a.actualStart), actualEndForBar) : null;
      const notStartedDelayBar = (!a.actualStart && isOverdue(a)) ? monthOverlap(a.plannedEnd, today) : null;
      const delayDays = a.actualEnd && a.plannedEnd && a.actualEnd > a.plannedEnd
        ? daysBetween(a.plannedEnd, a.actualEnd)
        : (!a.actualEnd && a.plannedEnd && isOverdue(a) ? daysBetween(a.plannedEnd, today) : 0);
      const pct = percentComplete(a);
      const visible = plannedBar || onTimeBar || delayBar || notStartedDelayBar;
      return { a, plannedBar, onTimeBar, delayBar, notStartedDelayBar, delayDays, pct, visible };
    }).filter(r => r.visible);
  }, [activities, cursor, today]);

  const unscheduled = activities.filter(a => !a.plannedStart || !a.plannedEnd);

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
      <>
      {rows.length === 0 ? (
        <div className="bg-white border rounded-sm p-4" style={{ borderColor: '#D9D2C2' }}>
          <p className="text-sm" style={{ color: '#8B8578' }}>No activities scheduled within {monthLabel}.</p>
        </div>
      ) : (
        <div className="bg-white border rounded-sm overflow-hidden flex" style={{ borderColor: '#D9D2C2' }}>
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
        <div className="bg-white border rounded-sm p-4" style={{ borderColor: '#D9D2C2' }}>
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
            <div className="bg-white border rounded-sm p-4" style={{ borderColor: '#D9D2C2' }}>
              <p className="text-sm" style={{ color: '#8B8578' }}>Select at least one stage above to visualize.</p>
            </div>
          ) : procRows.length === 0 ? (
            <div className="bg-white border rounded-sm p-4" style={{ borderColor: '#D9D2C2' }}>
              <p className="text-sm" style={{ color: '#8B8578' }}>No procurement activity for the selected stage(s) within {monthLabel}.</p>
            </div>
          ) : (
            <div className="bg-white border rounded-sm overflow-hidden flex" style={{ borderColor: '#D9D2C2' }}>
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

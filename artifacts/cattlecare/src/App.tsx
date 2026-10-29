import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ClerkProvider, Show, SignIn, SignUp, useAuth, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  Activity, AlertTriangle, ArrowRight, Check, ChevronDown,
  CircleHelp, ClipboardList, Cloud, CloudOff, Cpu, HeartPulse, LayoutDashboard, Leaf, LogOut,
  Menu, Plus, RefreshCw, Settings, ShieldCheck, SlidersHorizontal, Thermometer, Trash2, Wifi,
  X, Users, Pencil, Cable, Clock3, Radio, Stethoscope, ChevronRight, BookOpen, CalendarDays,
  MapPin,
} from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import {
  useHealthCheck,
  useReadThingSpeakFeeds,
} from '@workspace/api-client-react';
import type { ThingSpeakFeed, ThingSpeakFeedResponse } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const publicDemoMode = import.meta.env.VITE_PUBLIC_DEMO_MODE === 'true';
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

type Sensor = { id: string; name: string; type: string; sensorId: string; animalId: string; normalMin: number; normalMax: number; thresholdsConfigured?: boolean; criticalMin?: number; criticalMax?: number; thingSpeakField: string; connectionStatus: 'planned' | 'connected' };
type Cattle = { id: string; cattleId: string; name: string; breed: string; age: number };
type FarmLocation = { farmName: string; address: string; village: string; district: string; state: string; postalCode: string; latitude: string; longitude: string };
type FarmConfig = { channelId: string; autoRefreshEnabled: boolean; refreshSeconds: number };
type FarmData = { sensors: Sensor[]; cattle: Cattle[]; location: FarmLocation; config: FarmConfig };

const blankLocation: FarmLocation = { farmName: '', address: '', village: '', district: '', state: '', postalCode: '', latitude: '', longitude: '' };

function apiErrorMessage(error: unknown) {
  if (typeof error === 'string' && error.trim()) return error;
  if (!error || typeof error !== 'object') return 'The request could not be completed.';
  const value = error as {
    message?: string;
    error?: string;
    data?: { error?: string; message?: string };
    response?: { data?: { error?: string; message?: string } };
  };
  return value.response?.data?.error || value.response?.data?.message || value.data?.error || value.data?.message || value.error || value.message || 'The request could not be completed.';
}

function latestFeedEntry(feeds: ThingSpeakFeed[]) {
  return feeds.reduce<ThingSpeakFeed | null>((latest, entry) => {
    if (!latest) return entry;
    return new Date(entry.created_at).getTime() > new Date(latest.created_at).getTime() ? entry : latest;
  }, null);
}

function getProjectStatus(sensor: Sensor, rawValue: string | null | undefined) {
  if (!sensor.thresholdsConfigured) return null;
  if (rawValue == null || rawValue.trim() === '') return null;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return null;
  const belowCritical = sensor.criticalMin !== undefined && value < sensor.criticalMin;
  const aboveCritical = sensor.criticalMax !== undefined && value > sensor.criticalMax;
  if (belowCritical || aboveCritical) {
    return {
      status: 'critical' as const,
      reason: belowCritical ? `Below configured critical bound ${sensor.criticalMin}.` : `Above configured critical bound ${sensor.criticalMax}.`,
    };
  }
  const below = value < sensor.normalMin;
  const above = value > sensor.normalMax;
  if (!below && !above) return { status: 'normal' as const, reason: 'Within the project comparison range.' };
  return {
    status: 'warning' as const,
    reason: below ? `Below project minimum ${sensor.normalMin}.` : `Above project maximum ${sensor.normalMax}.`,
  };
}

function blankSensor(): Sensor {
  return { id: '', name: '', type: '', sensorId: '', animalId: '', normalMin: 0, normalMax: 0, thresholdsConfigured: false, criticalMin: undefined, criticalMax: undefined, thingSpeakField: '', connectionStatus: 'planned' };
}

const initialData: FarmData = {
  sensors: [
    { id: 'sensor-1', name: 'Temperature probe A', type: 'DS18B20', sensorId: 'TEMP-01', animalId: 'cow-1', normalMin: 0, normalMax: 0, thresholdsConfigured: false, thingSpeakField: 'field1', connectionStatus: 'planned' },
    { id: 'sensor-2', name: 'Pulse sensor', type: 'MAX30102', sensorId: 'PULSE-01', animalId: 'cow-2', normalMin: 0, normalMax: 0, thresholdsConfigured: false, thingSpeakField: 'field2', connectionStatus: 'planned' },
  ],
  cattle: [
    { id: 'cow-1', cattleId: 'CC-104', name: 'Gauri', breed: 'Gir', age: 5 },
    { id: 'cow-2', cattleId: 'CC-207', name: 'Malli', breed: 'Sahiwal', age: 3 },
    { id: 'cow-3', cattleId: 'CC-311', name: 'Kaveri', breed: 'Jersey cross', age: 4 },
  ],
  location: { ...blankLocation },
  config: {
    channelId: '',
    autoRefreshEnabled: true,
    refreshSeconds: 30,
  },
};
const emptyData: FarmData = {
  sensors: [],
  cattle: [],
  location: { ...blankLocation },
  config: {
    channelId: '',
    autoRefreshEnabled: true,
    refreshSeconds: 30,
  },
};

function useFarmData() {
  const [data, setData] = useState<FarmData>(() => {
    try {
      const saved = localStorage.getItem('cattlecare-farm');
      if (!saved) return emptyData;
      const parsed = JSON.parse(saved) as Partial<FarmData>;
      return {
        ...emptyData,
        ...parsed,
        cattle: Array.isArray(parsed.cattle) ? parsed.cattle.map((animal) => ({ ...animal, cattleId: animal.cattleId || '' })) : [],
        sensors: Array.isArray(parsed.sensors) ? parsed.sensors.map((sensor) => ({ ...sensor, thresholdsConfigured: sensor.thresholdsConfigured ?? false })) : [],
        location: { ...emptyData.location, ...parsed.location },
        config: {
          channelId: parsed.config?.channelId || '',
          autoRefreshEnabled: parsed.config?.autoRefreshEnabled ?? true,
          refreshSeconds: parsed.config?.refreshSeconds ?? 30,
        },
      };
    } catch { return emptyData; }
  });
  const update = (next: FarmData | ((old: FarmData) => FarmData)) => {
    setData((old) => {
      const value = typeof next === 'function' ? next(old) : next;
      localStorage.setItem('cattlecare-farm', JSON.stringify(value));
      return value;
    });
  };
  const [demo, setDemo] = useState(() => localStorage.getItem('cattlecare-demo') === 'true');
  const [sampleWorkspace, setSampleWorkspace] = useState(() => localStorage.getItem('cattlecare-sample') === 'true');
  const [feed, setFeed] = useState<ThingSpeakFeedResponse | null>(null);
  const [readApiKey, setReadApiKey] = useState('');
  const enterDemo = () => {
    if (!localStorage.getItem('cattlecare-farm')) {
      localStorage.setItem('cattlecare-farm', JSON.stringify(initialData));
      setData(initialData);
    }
    localStorage.setItem('cattlecare-sample', 'true');
    setSampleWorkspace(true);
    localStorage.setItem('cattlecare-demo', 'true');
    setDemo(true);
  };
  const leaveDemo = () => { localStorage.removeItem('cattlecare-demo'); setDemo(false); };
  return { data, update, demo, sampleWorkspace, feed, setFeed, readApiKey, setReadApiKey, enterDemo, leaveDemo };
}

function App() {
  if (!publicDemoMode && !clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in the environment');
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={publicDemoMode ? '' : basePath} hook={publicDemoMode ? useHashLocation : undefined}>
          {publicDemoMode ? <AppRoutes publicDemo /> : <ClerkProviderWithRoutes />}
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function stripBase(path: string) {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return <ClerkProvider
    publishableKey={clerkPubKey}
    proxyUrl={clerkProxyUrl}
    appearance={clerkAppearance}
    signInUrl={`${basePath}/sign-in`}
    signUpUrl={`${basePath}/sign-up`}
    localization={{
      signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to your CattleCare workspace' } },
      signUp: { start: { title: 'Start your project', subtitle: 'Create a student farm workspace' } },
    }}
    routerPush={(to) => setLocation(stripBase(to))}
    routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
  >
    <AppRoutes />
  </ClerkProvider>;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#315c42',
    colorForeground: '#254333',
    colorMutedForeground: '#6c7e70',
    colorDanger: '#aa4a40',
    colorBackground: '#f9f8f0',
    colorInput: '#fffef9',
    colorInputForeground: '#254333',
    colorNeutral: '#d8ddce',
    fontFamily: 'DM Sans, sans-serif',
    borderRadius: '0.8rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#f9f8f0] rounded-[24px] w-[440px] max-w-full overflow-hidden shadow-[0_16px_50px_rgba(33,60,42,.11)]',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#254333] font-semibold',
    headerSubtitle: 'text-[#6c7e70]',
    socialButtonsBlockButtonText: 'text-[#254333]',
    formFieldLabel: 'text-[#355543]',
    footerActionLink: 'text-[#315c42] font-semibold',
    footerActionText: 'text-[#6c7e70]',
    dividerText: 'text-[#718176]',
    identityPreviewEditButton: 'text-[#315c42]',
    formFieldSuccessText: 'text-[#315c42]',
    alertText: 'text-[#713c32]',
    logoBox: 'rounded-xl',
    logoImage: 'rounded-xl',
    socialButtonsBlockButton: 'border-[#d8ddce] bg-[#fffef9] hover:bg-[#eef1e7]',
    formButtonPrimary: 'bg-[#315c42] hover:bg-[#254c35] text-white shadow-none',
    formFieldInput: 'bg-[#fffef9] border-[#d8ddce] text-[#254333]',
    footerAction: 'border-t border-[#e5e7dd]',
    dividerLine: 'bg-[#d8ddce]',
    alert: 'bg-[#fbf0e7] border-[#ead8c6]',
    otpCodeFieldInput: 'bg-[#fffef9] border-[#d8ddce]',
    formFieldRow: 'gap-2',
    main: 'gap-4',
  },
};

function AppRoutes({ publicDemo = false }: { publicDemo?: boolean }) {
  const farm = useFarmData();
  const protectedPage = (content: ReactNode) => publicDemo
    ? <PublicDemoProtectedRoute farm={farm}>{content}</PublicDemoProtectedRoute>
    : <ProtectedRoute farm={farm}>{content}</ProtectedRoute>;
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={() => publicDemo ? <PublicDemoHomeRoute farm={farm} /> : <HomeRoute farm={farm} />} />
        <Route path="/sign-in/*?" component={() => publicDemo ? <Redirect to="/" /> : <SignInPage />} />
        <Route path="/sign-up/*?" component={() => publicDemo ? <Redirect to="/" /> : <SignUpPage />} />
        <Route path="/dashboard" component={() => protectedPage(<Dashboard data={farm.data} update={farm.update} sampleWorkspace={farm.sampleWorkspace} />)} />
        <Route path="/live" component={() => protectedPage(<LivePage data={farm.data} feed={farm.feed} setFeed={farm.setFeed} readApiKey={farm.readApiKey} />)} />
        <Route path="/thingspeak" component={() => protectedPage(<ThingSpeakPage data={farm.data} update={farm.update} feed={farm.feed} setFeed={farm.setFeed} readApiKey={farm.readApiKey} setReadApiKey={farm.setReadApiKey} />)} />
        <Route path="/sensors" component={() => protectedPage(<SensorsPage data={farm.data} update={farm.update} />)} />
        <Route path="/cattle" component={() => protectedPage(<CattlePage data={farm.data} update={farm.update} feed={farm.feed} />)} />
        <Route path="/alerts" component={() => protectedPage(<AlertsPage data={farm.data} feed={farm.feed} />)} />
        <Route path="/about" component={() => protectedPage(<AboutPage />)} />
        <Route path="/settings" component={() => protectedPage(<SettingsPage data={farm.data} update={farm.update} />)} />
        <Route path="/location" component={() => protectedPage(<LocationPage data={farm.data} update={farm.update} />)} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function PublicDemoHomeRoute({ farm }: { farm: ReturnType<typeof useFarmData> }) {
  if (farm.demo) return <Redirect to="/dashboard" />;
  return <Landing onDemo={farm.enterDemo} demoOnly />;
}

function HomeRoute({ farm }: { farm: ReturnType<typeof useFarmData> }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (farm.demo) return <Redirect to="/dashboard" />;
  if (!isLoaded) return <div className="min-h-[100dvh] bg-[#f3f1e7] p-8"><div className="skeleton h-8 w-48" /></div>;
  return <>{isSignedIn ? <Redirect to="/dashboard" /> : <Show when="signed-out"><Landing onDemo={farm.enterDemo} /></Show>}</>;
}

function Landing({ onDemo, demoOnly = false }: { onDemo: () => void; demoOnly?: boolean }) {
  return (
    <main className="grain min-h-[100dvh] overflow-hidden bg-[#f4f2e8] text-[#203e2e]" data-testid="page-login">
      <header className="relative z-10 mx-auto flex max-w-[1320px] items-center justify-between px-6 py-6 md:px-12">
        <Brand />
        {!demoOnly && <div className="flex items-center gap-4">
          <Link href="/sign-in" className="text-sm font-semibold hover:text-[#66836a]" data-testid="link-sign-in">Sign in</Link>
          <Link href="/sign-up" className="rounded-full bg-[#315c42] px-5 py-2.5 text-sm font-semibold text-[#f6f5e9] transition hover:bg-[#234832]" data-testid="link-sign-up">Create account</Link>
        </div>}
      </header>
      <section className="relative mx-auto grid max-w-[1320px] items-center gap-10 px-6 pb-16 pt-10 md:grid-cols-[1.02fr_.98fr] md:px-12 md:pb-24 md:pt-16">
          <div className="relative z-10 order-2 min-w-0 w-full max-w-[650px] page-enter md:order-1">
          <span className="eyebrow"><span className="h-2 w-2 rounded-full bg-[#879e6b]" /> A student-built farm prototype</span>
          <h1 className="mt-7 font-serif text-[clamp(3.5rem,7.5vw,7rem)] leading-[.96] tracking-[-.02em]">Care begins<br /><i className="font-medium text-[#76916b]">with a signal.</i></h1>
          <p className="mt-7 max-w-[500px] text-[17px] leading-7 text-[#607363]">A clear workspace for planning wearable sensors, organizing a herd, and checking real readings when your prototype is transmitting.</p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <button onClick={onDemo} className="inline-flex items-center gap-2 rounded-full border border-[#cbd4c3] bg-[#faf9f2] px-6 py-3.5 text-sm font-semibold text-[#315c42] hover:bg-[#e9eee3]" data-testid="button-enter-demo">Explore sample workspace <ArrowRight size={15} /></button>
            {!demoOnly && <Link href="/sign-up" className="rounded-full px-4 py-3.5 text-sm font-semibold text-[#45674c] hover:bg-[#e8ecdf]" data-testid="link-home-sign-up">Create account</Link>}
          </div>
          <p className="mt-4 text-xs text-[#7d8c7d]">Sample mode uses illustrative project records. It is not a live farm connection.</p>
          <div className="mt-14 flex gap-8 border-t border-[#d8ddce] pt-5 text-xs text-[#7b887a]">
            <span>01 <b className="ml-2 font-medium text-[#365b43]">Plan hardware</b></span>
            <span>02 <b className="ml-2 font-medium text-[#365b43]">Map signals</b></span>
            <span>03 <b className="ml-2 font-medium text-[#365b43]">Review readings</b></span>
          </div>
        </div>
        <div className="relative mx-auto order-1 min-w-0 w-full max-w-[560px] page-enter [animation-delay:100ms] md:order-2">
          <div className="absolute -right-8 -top-8 h-40 w-40 rounded-full bg-[#e5e8d9] blur-2xl" />
          <div className="relative overflow-hidden rounded-[34px] bg-[#dce6d4] p-4 sm:p-6">
            <div className="absolute -right-12 top-12 h-64 w-64 rounded-full border border-[#a9bea0]/65" />
            <div className="absolute -right-1 top-24 h-44 w-44 rounded-full border border-[#a9bea0]/60" />
            <div className="relative mb-4 flex items-center justify-between px-1 text-[10px] font-bold uppercase tracking-[.17em] text-[#58735a]"><span>{demoOnly ? 'Farm workspace · Public demo' : 'Farm workspace · Sign in'}</span><span>{demoOnly ? 'Local sample' : 'Secure access'}</span></div>
            <div className="relative rounded-[26px] bg-[#f9f8f0] px-3 py-5 shadow-[0_18px_50px_rgba(40,66,43,.10)] sm:px-5">
              {demoOnly
                ? <div className="py-8 text-center"><Leaf className="mx-auto text-[#527252]" size={28} /><h2 className="mt-4 font-serif text-2xl text-[#254333]">Explore the sample farm</h2><p className="mx-auto mt-2 max-w-xs text-sm leading-6 text-[#718073]">Try the dashboard, herd profiles, sensor mapping, and settings. Your changes stay in this browser.</p></div>
                : <><SignIn routing="path" path={`${basePath}/`} signUpUrl={`${basePath}/sign-up`} /><div className="mx-auto mt-3 flex max-w-[440px] items-center justify-between border-t border-[#e6e9df] px-2 pt-4 text-xs"><Link href="/sign-in/forgot-password" className="font-semibold text-[#527252] hover:underline" data-testid="link-forgot-password">Forgot password?</Link><Link href="/sign-up" className="font-semibold text-[#315c42] hover:underline" data-testid="link-inline-sign-up">Create account</Link></div></>}
            </div>
            <p className="relative mt-4 text-center text-[10px] leading-4 text-[#668067]">No channel is assumed live until a ThingSpeak read succeeds.</p>
          </div>
        </div>
      </section>
      <footer className="mx-auto flex max-w-[1320px] items-center justify-between border-t border-[#d8ddce] px-6 py-5 text-xs text-[#829082] md:px-12"><span>Student prototype · CattleCare</span><span>Monitoring support, not veterinary advice</span></footer>
    </main>
  );
}

function SignInPage() {
  return <AuthPage><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></AuthPage>;
}
function SignUpPage() {
  return <AuthPage><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></AuthPage>;
}
function AuthPage({ children }: { children: ReactNode }) {
  return <main className="grain flex min-h-[100dvh] flex-col items-center justify-center gap-5 bg-[#f1f0e6] px-4 py-8"><Link href="/" className="mb-1" data-testid="link-auth-home"><Brand /></Link><div className="w-full">{children}</div><p className="text-center text-xs text-[#7e8b7c]">CattleCare · student prototype workspace</p></main>;
}

function ProtectedRoute({ farm, children }: { farm: ReturnType<typeof useFarmData>; children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <LoadingScreen />;
  if (!farm.demo && !isSignedIn) return <Redirect to="/" />;
  return <AppFrame farm={farm}>{children}</AppFrame>;
}

function PublicDemoProtectedRoute({ farm, children }: { farm: ReturnType<typeof useFarmData>; children: ReactNode }) {
  if (!farm.demo) return <Redirect to="/" />;
  return <AppFrame farm={farm} publicDemo>{children}</AppFrame>;
}

function AppFrame({ farm, children, publicDemo = false }: { farm: ReturnType<typeof useFarmData>; children: ReactNode; publicDemo?: boolean }) {
  if (publicDemo) {
    return <AppFrameLayout farm={farm} onLogout={() => { farm.setReadApiKey(''); farm.leaveDemo(); }} userName="Guest explorer">{children}</AppFrameLayout>;
  }
  return <AuthenticatedAppFrame farm={farm}>{children}</AuthenticatedAppFrame>;
}

function AuthenticatedAppFrame({ farm, children }: { farm: ReturnType<typeof useFarmData>; children: ReactNode }) {
  const { signOut } = useClerk();
  const { user } = useUser();
  const logout = async () => {
    farm.setReadApiKey('');
    if (farm.demo) farm.leaveDemo();
    else await signOut({ redirectUrl: basePath || '/' });
  };
  return <AppFrameLayout farm={farm} onLogout={logout} userName={user?.firstName || (farm.demo ? 'Guest explorer' : 'Farm team')}>{children}</AppFrameLayout>;
}

function AppFrameLayout({ farm, children, onLogout, userName }: { farm: ReturnType<typeof useFarmData>; children: ReactNode; onLogout: () => void | Promise<void>; userName: string }) {
  const [location, setLocation] = useLocation();
  const health = useHealthCheck({ query: { enabled: !farm.demo } });
  const active = navItems.find((item) => item.href === location);
  const [mobileNav, setMobileNav] = useState(false);
  const logout = async () => {
    await onLogout();
    setLocation('/');
  };
  return (
    <div className="min-h-[100dvh] bg-[#f3f2e9] text-[#243f2f] md:flex" data-testid="app-shell">
      <aside className="hidden w-[248px] shrink-0 flex-col bg-[#254b36] text-[#edf0e3] md:flex">
        <div className="px-6 pb-7 pt-7"><Brand inverse /><p className="ml-10 mt-1 text-[10px] uppercase tracking-[.17em] text-[#a9bda8]">Farm project workspace</p></div>
        <div className="mx-5 mb-4 flex items-center gap-3 rounded-2xl border border-[#41624b] bg-[#2d553d] px-3.5 py-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#d7e2ca] text-[#31563c]"><Leaf size={17} /></span>
          <div className="min-w-0"><p className="truncate text-xs font-semibold">Student farm</p><p className="mt-1 text-[10px] text-[#b5c7b2]">{farm.demo ? 'Sample workspace' : 'My workspace'}</p></div>
          <ChevronDown size={14} className="ml-auto text-[#afc1ac]" />
        </div>
        <p className="px-7 pb-2 pt-3 text-[9px] font-bold uppercase tracking-[.2em] text-[#9fb39f]">Farm overview</p>
        <nav className="flex-1 px-3" aria-label="Main navigation">
          {navItems.map((item) => <Link href={item.href} key={item.href} onClick={() => setMobileNav(false)} className={`nav-link ${location === item.href ? 'nav-active' : ''}`} data-testid={`link-nav-${item.key}`}><item.icon size={17} strokeWidth={1.8} /><span>{item.label}</span>{item.key === 'alerts' && <span className="ml-auto rounded-full bg-[#d5e1c9] px-1.5 py-0.5 text-[9px] font-bold text-[#31563c]">0</span>}</Link>)}
        </nav>
        <div className="mx-5 mb-5 rounded-2xl border border-[#41624b] bg-[#2d553d] p-3.5">
          <div className="flex items-center gap-2 text-[11px] font-semibold" data-testid="status-api"><span className={`h-2 w-2 rounded-full ${farm.demo || health.isSuccess ? 'bg-[#9fbe83]' : health.isError ? 'bg-[#e6a395]' : 'bg-[#d3b87b]'}`} />API {farm.demo ? 'demo' : health.data?.status || (health.isError ? 'unavailable' : health.isPending ? 'checking' : 'unknown')}</div>
          <p className="mt-2 text-[10px] leading-4 text-[#b8c9b6]">{farm.demo ? 'Public demo records are stored in this browser; no API service is connected.' : health.isError ? 'Could not reach the service. Farm records remain on this device.' : health.isSuccess ? 'Service health check responded.' : 'Checking service status…'}</p>
          {!farm.demo && health.isError && <button onClick={() => health.refetch()} className="mt-2 text-[10px] font-semibold text-[#d8e5c9]" data-testid="button-retry-health">Retry check</button>}
        </div>
        <button onClick={logout} className="mx-4 mb-5 flex items-center gap-3 rounded-xl px-4 py-3 text-left text-xs font-semibold text-[#d3dfd1] hover:bg-[#315940]" data-testid="button-logout"><LogOut size={16} /> {farm.demo ? 'Exit sample workspace' : 'Sign out'}</button>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex h-[68px] items-center justify-between border-b border-[#dfe3d6] bg-[#f8f7f0]/95 px-4 backdrop-blur md:px-8">
          <div className="flex items-center gap-3">
            <button className="rounded-lg p-2 text-[#315c42] md:hidden" onClick={() => setMobileNav(!mobileNav)} aria-label="Toggle navigation" data-testid="button-mobile-nav"><Menu size={20} /></button>
            <div><p className="text-[10px] font-semibold uppercase tracking-[.16em] text-[#829082]">CattleCare / Farm</p><h1 className="text-sm font-semibold">{active?.label || 'Workspace'}</h1></div>
          </div>
          <div className="flex items-center gap-3">
            {farm.sampleWorkspace && <span className="rounded-full border border-[#d7c995] bg-[#f5f0db] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#82713f]" data-testid="status-sample-workspace">Sample records</span>}
            <span className="hidden text-xs text-[#708071] sm:inline">{userName}</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#dce7d4] text-xs font-bold text-[#315c42]">{userName[0] || 'F'}</span>
          </div>
        </header>
        {mobileNav && <div className="fixed inset-0 z-30 bg-[#203e2e]/25 md:hidden" onClick={() => setMobileNav(false)}><div className="w-[290px] min-h-full bg-[#254b36] p-4 text-white" onClick={(event) => event.stopPropagation()}><div className="mb-7 flex items-center justify-between"><Brand inverse /><button onClick={() => setMobileNav(false)} data-testid="button-close-mobile-nav"><X /></button></div>{navItems.map((item) => <Link key={item.href} href={item.href} onClick={() => setMobileNav(false)} className={`nav-link ${location === item.href ? 'nav-active' : ''}`} data-testid={`mobile-link-nav-${item.key}`}><item.icon size={17} />{item.label}</Link>)}<button onClick={logout} className="nav-link mt-5 w-full" data-testid="mobile-button-logout"><LogOut size={17} />Sign out</button></div></div>}
        <main className="mx-auto max-w-[1440px] p-4 pb-12 md:p-8">{farm.sampleWorkspace && <div className="mb-5 flex items-start gap-3 rounded-2xl border border-[#e3d8b4] bg-[#f7f1dc] px-4 py-3.5 text-[#695d3d]" data-testid="notice-sample-data"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><p className="text-xs leading-5"><b>Sample records.</b> Herd, hardware, and thresholds are illustrative records. They do not represent a connected farm or measured animal data.</p></div>}{children}</main>
      </div>
    </div>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

const navItems = [
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { key: 'live', label: 'Live readings', href: '/live', icon: Activity },
  { key: 'thingspeak', label: 'ThingSpeak', href: '/thingspeak', icon: Cloud },
  { key: 'cattle', label: 'Cattle profiles', href: '/cattle', icon: Users },
  { key: 'sensors', label: 'Sensors & mapping', href: '/sensors', icon: Cpu },
  { key: 'alerts', label: 'Threshold alerts', href: '/alerts', icon: AlertTriangle },
  { key: 'about', label: 'About prototype', href: '/about', icon: BookOpen },
  { key: 'settings', label: 'Settings', href: '/settings', icon: Settings },
  { key: 'location', label: 'Location', href: '/location', icon: MapPin },
];

function Brand({ inverse = false }: { inverse?: boolean }) {
  return <span className="inline-flex items-center gap-2.5" data-testid="brand-cattlecare"><span className={`flex h-8 w-8 items-center justify-center rounded-xl ${inverse ? 'bg-[#dce7d0] text-[#315b41]' : 'bg-[#315c42] text-[#f4f1df]'}`}><Leaf size={17} strokeWidth={2.2} /></span><span className={`font-serif text-[22px] font-semibold tracking-[-.04em] ${inverse ? 'text-[#f4f1e8]' : 'text-[#254b36]'}`}>cattlecare<span className={inverse ? 'text-[#a9c18f]' : 'text-[#7c956d]'}>.</span></span></span>;
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end" data-testid="page-heading"><div><p className="text-[10px] font-bold uppercase tracking-[.19em] text-[#789078]">{eyebrow}</p><h2 className="mt-2 font-serif text-[38px] leading-none tracking-[-.045em] text-[#244432] md:text-[46px]">{title}</h2><p className="mt-3 max-w-2xl text-sm leading-6 text-[#718073]">{description}</p></div>{action}</div>;
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-[20px] border border-[#e0e4d9] bg-[#fbfaf4] shadow-[0_4px_16px_rgba(38,61,41,.035)] ${className}`}>{children}</section>;
}
function CardTitle({ icon: Icon, title, detail, aside }: { icon?: typeof Activity; title: string; detail?: string; aside?: ReactNode }) {
  return <div className="flex items-center justify-between gap-3 border-b border-[#e8eadf] px-5 py-4"><div className="flex items-center gap-3">{Icon && <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#edf1e6] text-[#4e7456]"><Icon size={16} /></span>}<div><h3 className="text-sm font-semibold">{title}</h3>{detail && <p className="mt-0.5 text-[11px] text-[#879287]">{detail}</p>}</div></div>{aside}</div>;
}
function Pill({ children, tone = 'sage' }: { children: ReactNode; tone?: 'sage' | 'amber' | 'plain' | 'live' | 'red' }) {
  const styles = { sage: 'bg-[#e8eee2] text-[#496a4f]', amber: 'bg-[#f4edda] text-[#806d3e]', plain: 'bg-[#eff0e9] text-[#687669]', live: 'bg-[#e2efe2] text-[#386c42]', red: 'bg-[#f7e9e5] text-[#a64c3f]' };
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.08em] ${styles[tone]}`}>{children}</span>;
}
function Button({ children, onClick, variant = 'primary', testId, type = 'button', disabled = false }: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'outline' | 'quiet' | 'danger'; testId: string; type?: 'button' | 'submit'; disabled?: boolean }) {
  const styles = { primary: 'bg-[#315c42] text-[#f6f5e9] hover:bg-[#244b35]', outline: 'border border-[#cdd7c8] bg-[#fbfaf4] text-[#315c42] hover:bg-[#edf1e6]', quiet: 'text-[#59705c] hover:bg-[#edf1e6]', danger: 'border border-[#ebd0c9] text-[#a44c41] hover:bg-[#f8e9e5]' };
  return <button type={type} disabled={disabled} onClick={onClick} className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 ${styles[variant]}`} data-testid={testId}>{children}</button>;
}
function Stat({ label, value, detail, icon: Icon, tone = 'green' }: { label: string; value: string | number; detail: string; icon: typeof Activity; tone?: 'green' | 'gold' | 'sage' }) {
  const tint = { green: 'bg-[#e5ede1] text-[#4a7453]', gold: 'bg-[#f3edda] text-[#917c45]', sage: 'bg-[#e5ece8] text-[#53746a]' };
  return <Card className="p-5" ><div className="flex items-start justify-between"><span className="text-[10px] font-bold uppercase tracking-[.16em] text-[#879285]">{label}</span><span className={`flex h-9 w-9 items-center justify-center rounded-xl ${tint[tone]}`}><Icon size={17} /></span></div><p className="mt-5 font-serif text-[34px] leading-none tracking-tight">{value}</p><p className="mt-2 text-[11px] text-[#839083]">{detail}</p></Card>;
}

function Dashboard({ data, update, sampleWorkspace }: { data: FarmData; update: (next: FarmData | ((old: FarmData) => FarmData)) => void; sampleWorkspace: boolean }) {
  const [editor, setEditor] = useState<Sensor | null>(null);
  const savedLocation = [data.location.address, data.location.village, data.location.district, data.location.state].filter(Boolean).join(', ');
  const [savedLocationInput, setSavedLocationInput] = useState(data.location.address);
  const saveSensor = (event: FormEvent, form: Sensor) => {
    event.preventDefault();
    if (!form.name.trim()) return;
    const sensor = { ...form, id: form.id || crypto.randomUUID() };
    update((old) => ({ ...old, sensors: [...old.sensors, sensor] }));
    setEditor(null);
  };
  return <div className="page-enter">
    <PageHeading eyebrow="Farm overview" title="A clear view of the build." description="Keep the herd, planned hardware, and data connection in one place. No live readings until a channel is connected." action={<div className="flex flex-wrap gap-2"><Button onClick={() => setEditor(blankSensor())} variant="outline" testId="button-dashboard-add-sensor"><Plus size={15} />Add Sensor</Button><Link href="/thingspeak" className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#cdd7c8] bg-[#fbfaf4] px-4 text-xs font-semibold text-[#315c42] hover:bg-[#edf1e6]" data-testid="button-connect-channel"><Cloud size={15} /> Connect a channel <ArrowRight size={14} /></Link></div>} />
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Stat label="Cattle profiles" value={data.cattle.length.toString().padStart(2, '0')} detail={sampleWorkspace ? 'Sample profile records' : 'Profiles in this workspace'} icon={Users} />
      <Stat label="Sensor records" value={data.sensors.length.toString().padStart(2, '0')} detail={`${data.sensors.filter((s) => s.connectionStatus === 'connected').length} marked physically connected`} icon={Cpu} tone="sage" />
      <Stat label="Mapped sensors" value={data.sensors.filter((sensor) => sensor.thingSpeakField).length.toString().padStart(2, '0')} detail="Assigned to channel fields" icon={Cable} tone="gold" />
      <Stat label="Live channel" value="—" detail="Waiting for channel connection" icon={Radio} tone="sage" />
    </div>
    <div className="mt-5 grid gap-5 xl:grid-cols-[1.35fr_.85fr]">
      <Card><CardTitle icon={Activity} title="Monitoring status" detail="Data state for this prototype" aside={<Pill tone="amber">Waiting for data</Pill>} /><div className="grid gap-5 p-5 md:grid-cols-[1fr_230px] md:p-6"><div><h3 className="font-serif text-2xl">The channel is not connected yet.</h3><p className="mt-2 max-w-xl text-sm leading-6 text-[#748275]">Connect a ThingSpeak channel after the physical device begins transmitting. Until then, this workspace only contains your project records.</p><Link href="/thingspeak" className="mt-5 inline-flex items-center gap-2 text-xs font-bold text-[#315c42]" data-testid="link-setup-thingspeak">Set up ThingSpeak <ArrowRight size={14} /></Link></div><div className="flex min-h-[132px] flex-col justify-between rounded-2xl bg-[#edf1e7] p-4"><div className="flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-[.15em] text-[#748674]">Incoming feed</span><CloudOff size={16} className="text-[#829681]" /></div><p className="font-serif text-3xl text-[#82927e]">No feed</p><p className="text-[10px] text-[#879285]">This is not a sensor fault diagnosis.</p></div></div></Card>
      <Card><CardTitle icon={CalendarDays} title="Build checklist" detail="From plan to physical signal" /><div className="space-y-0 p-5">{[
        ['01', 'Assign sensors', `${data.sensors.length} sensor records`, '/sensors'],
        ['02', 'Connect data', data.config.channelId ? `Channel ${data.config.channelId}` : 'No channel configured', '/thingspeak'],
        ['03', 'Set farm location', data.location.farmName || 'Add farm details', '/location'],
      ].map(([n, title, detail, href], index) => <Link href={href} key={n} className="flex items-center gap-3 border-b border-[#edf0e8] py-3 last:border-0" data-testid={`link-checklist-${n}`}><span className={`flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-bold ${index === 0 ? 'bg-[#315c42] text-white' : 'bg-[#e8eee2] text-[#53735a]'}`}>{n}</span><span className="min-w-0 flex-1"><b className="block text-xs">{title}</b><span className="mt-1 block truncate text-[10px] text-[#879287]">{detail}</span></span><ChevronRight size={15} className="text-[#8c9b8c]" /></Link>)}</div></Card>
    </div>
    <div className="mt-5 grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
      <Card><CardTitle icon={Users} title="Cattle profiles" detail="Assigned animals in this project" aside={<Link href="/cattle" className="text-[11px] font-semibold text-[#4b7053]" data-testid="link-all-cattle">All profiles <ArrowRight size={13} className="inline" /></Link>} /><div className="divide-y divide-[#edf0e8]">{data.cattle.slice(0, 3).map((cow, index) => <div key={cow.id} className="flex items-center gap-3 px-5 py-3.5" data-testid={`row-cattle-${cow.id}`}><span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#e8eee2] font-serif text-sm text-[#55775c]">{cow.name.slice(0, 1)}</span><div className="flex-1"><p className="text-xs font-semibold">{cow.name}</p><p className="mt-1 text-[10px] text-[#849084]">{cow.breed} · {cow.age} years</p></div><span className="text-[10px] text-[#879287]">{index === 0 ? 'Sensor record' : 'No sensor assigned'}</span></div>)}</div></Card>
      <Card className="overflow-hidden"><div className="relative h-full min-h-[230px] bg-[#e8ecdd] p-5"><div className="absolute -right-8 -top-8 h-40 w-40 rounded-full border border-[#bdcbb4]" /><div className="absolute -right-1 top-0 h-32 w-32 rounded-full border border-[#bdcbb4]" /><p className="relative text-[10px] font-bold uppercase tracking-[.18em] text-[#6d816b]">A note on health data</p><h3 className="relative mt-4 max-w-[330px] font-serif text-3xl leading-tight">Signals can support care. They are not a diagnosis.</h3><p className="relative mt-3 max-w-sm text-xs leading-5 text-[#6e806f]">Use validated hardware and seek veterinary advice for any health concern. This student prototype does not diagnose, forecast, or replace a veterinarian.</p><Link href="/about" className="relative mt-5 inline-flex items-center gap-2 text-xs font-bold text-[#315c42]" data-testid="link-prototype-notes">Read prototype notes <ArrowRight size={13} /></Link></div></Card>
    </div>
    <Card className="mt-5"><CardTitle icon={MapPin} title="Farm location" detail={savedLocation || 'Add or update the location saved with this workspace'} aside={<Link href="/location" className="text-xs font-semibold text-[#315c42]" data-testid="link-edit-location">Full location details <ArrowRight size={13} className="inline" /></Link>} /><form className="flex flex-col gap-3 p-5 sm:flex-row sm:items-end" onSubmit={(event) => { event.preventDefault(); update((old) => ({ ...old, location: { ...old.location, address: savedLocationInput } })); }}><Field label="Location"><input className="field-input" value={savedLocationInput} onChange={(event) => setSavedLocationInput(event.target.value)} placeholder="Enter farm address, town, or landmark" data-testid="input-dashboard-location" /></Field><div className="flex shrink-0 gap-2"><Button type="submit" testId="button-save-dashboard-location"><Check size={14} />Save location</Button>{savedLocationInput.trim() && <a className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#cdd7c8] bg-[#fbfaf4] px-4 text-xs font-semibold text-[#315c42] hover:bg-[#edf1e6]" href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(savedLocationInput)}`} target="_blank" rel="noreferrer" data-testid="link-dashboard-location-map"><MapPin size={14} />Search map</a>}</div></form></Card>
    {editor && <SensorForm editor={editor} data={data} title="Add a sensor" onSave={saveSensor} onClose={() => setEditor(null)} />}
  </div>;
}

function LivePage({ data, feed, setFeed, readApiKey }: { data: FarmData; feed: ThingSpeakFeedResponse | null; setFeed: (value: ThingSpeakFeedResponse | null) => void; readApiKey: string }) {
  const response = feed;
  const [sampleVisible, setSampleVisible] = useState(false);
  const [trendField, setTrendField] = useState('');
  const [error, setError] = useState('');
  const { mutate, isPending } = useReadThingSpeakFeeds();
  const refresh = () => {
    if (!data.config.channelId) { setError('Add a channel ID on the ThingSpeak page before requesting a feed.'); return; }
    setError('');
    mutate({ data: { channelId: data.config.channelId, ...(readApiKey ? { readApiKey } : {}), results: 30 } }, {
      onSuccess: (value) => { setFeed(value); },
      onError: (requestError) => { setError(apiErrorMessage(requestError)); },
    });
  };
  useEffect(() => {
    if (!data.config.autoRefreshEnabled || !feed || !data.config.channelId) return;
    const timer = window.setInterval(refresh, data.config.refreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [feed, data.config.autoRefreshEnabled, data.config.channelId, data.config.refreshSeconds, readApiKey]);
  const latest = response?.feeds?.length ? latestFeedEntry(response.feeds) : null;
  const configured = Boolean(data.config.channelId && response);
  const hasRealReadings = Boolean(response?.feeds?.length);
  const allFields = Array.from({ length: 8 }, (_, index) => `field${index + 1}`);
  const discoveredFields = response ? allFields.filter((field) => {
    const channelLabel = response.channel[field as keyof typeof response.channel];
    const hasValues = response.feeds.some((entry) => {
      const value = entry[field as keyof ThingSpeakFeed];
      return value !== null && value !== undefined && value !== '';
    });
    return Boolean(channelLabel) || hasValues;
  }) : [];
  const sensorFields = data.sensors.filter((sensor) => sensor.thingSpeakField).map((sensor) => sensor.thingSpeakField);
  const liveFields = Array.from(new Set([...sensorFields, ...discoveredFields]));
  const sensorCards = data.sensors.map((sensor) => ({ sensor, field: sensor.thingSpeakField, label: sensor.name }));
  const fieldCards = liveFields.filter((field) => !data.sensors.some((sensor) => sensor.thingSpeakField === field)).map((field) => ({
    sensor: undefined,
    field,
    label: field,
  }));
  const cards = [...sensorCards, ...fieldCards];
  const chartField = trendField && liveFields.includes(trendField) ? trendField : liveFields[0] || '';
  const chartData = response?.feeds?.filter((entry) => {
    const value = entry[chartField as keyof ThingSpeakFeed];
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  }).map((entry) => ({
    timestamp: new Date(entry.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    value: Number(entry[chartField as keyof ThingSpeakFeed]),
  })) || [];
  return <div className="page-enter">
    <PageHeading eyebrow="Monitoring / incoming feed" title="Live readings" description="Live cards, trends, and alert comparisons use real ThingSpeak feed entries only." action={<div className="flex items-center gap-2"><Pill tone={data.config.autoRefreshEnabled ? 'sage' : 'plain'}>{data.config.autoRefreshEnabled ? `Auto · ${data.config.refreshSeconds}s` : 'Auto refresh off'}</Pill><Button onClick={refresh} disabled={isPending || !data.config.channelId} variant="outline" testId="button-refresh-live"><RefreshCw size={14} className={isPending ? 'animate-spin' : ''} />{isPending ? 'Refreshing…' : 'Refresh feed'}</Button></div>} />
    {error && <div className="mb-5 flex items-start gap-2 rounded-xl border border-[#efd0c8] bg-[#fbefea] p-3 text-xs text-[#934a40]" role="alert" data-testid="status-feed-error"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><span><b>ThingSpeak request failed:</b> {error}</span></div>}
    <Card>
      <div className="flex flex-col justify-between gap-3 border-b border-[#e8eadf] p-5 sm:flex-row sm:items-center"><div className="flex items-center gap-3"><span className={`flex h-10 w-10 items-center justify-center rounded-xl ${configured ? 'bg-[#e2efe2] text-[#47744f]' : 'bg-[#f3edda] text-[#887746]'}`}><Activity size={18} /></span><div><p className="text-sm font-semibold">{configured ? (response?.channel.name || `Channel ${response?.channel.id || data.config.channelId}`) : 'Waiting for sensor data'}</p><p className="mt-1 text-[11px] text-[#839083]">{configured ? `Last request succeeded · ${response?.feeds.length || 0} feed entries` : data.config.channelId ? 'Channel configured · waiting for a successful feed read' : 'No channel connected'}</p></div></div><Pill tone={configured ? (hasRealReadings ? 'live' : 'amber') : 'amber'}>{configured ? hasRealReadings ? 'Successful read · real feed' : 'Read succeeded · waiting for sensor data' : 'Waiting for sensor data'}</Pill></div>
      {cards.length ? <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-3">{cards.map(({ sensor, field, label }, index) => {
        const value = latest && field ? latest[field as keyof ThingSpeakFeed] : null;
        const threshold = sensor && field ? getProjectStatus(sensor, typeof value === 'string' ? value : null) : null;
        const statusTone = threshold?.status === 'critical' ? 'red' : threshold?.status === 'warning' ? 'amber' : threshold?.status === 'normal' ? 'live' : 'plain';
        return <div key={`${sensor?.id || field}-${index}`} className="rounded-2xl border border-[#e4e7dd] bg-[#faf9f3] p-4" data-testid={`reading-card-${sensor?.id || field || index}`}>
          <div className="flex items-start justify-between gap-2"><div><p className="text-xs font-semibold">{label}</p><p className="mt-1 font-mono text-[9px] uppercase text-[#829082]">{field || 'No ThingSpeak field mapped'}</p></div>{threshold && <Pill tone={statusTone}>{threshold.status}</Pill>}</div>
          <p className="mt-5 font-serif text-3xl">{value == null || value === '' ? '—' : value}</p>
          <p className="mt-2 text-[10px] text-[#929c90]">{latest?.created_at ? new Date(latest.created_at).toLocaleString() : 'Waiting for sensor data'}</p>
          {threshold && <p className="mt-2 border-t border-[#e8eadf] pt-2 text-[10px] text-[#768477]">{threshold.reason}</p>}
          {!hasRealReadings && <p className="mt-2 text-[10px] font-semibold text-[#9a8144]">Waiting for sensor data</p>}
        </div>;
      })}</div> : <div className="flex flex-col items-center px-5 py-10 text-center" data-testid="status-waiting-sensor-data"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#f3edda] text-[#8d7948]"><Clock3 size={19} /></span><h3 className="mt-3 font-serif text-xl">Waiting for sensor data</h3><p className="mt-1 max-w-sm text-xs leading-5 text-[#829082]">Add configured sensors or connect a ThingSpeak channel with discovered fields to see measurement cards.</p></div>}
      {!hasRealReadings && <div className="mx-5 mb-5 flex flex-col gap-3 rounded-2xl bg-[#eff1e8] p-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex gap-3"><Clock3 size={16} className="mt-0.5 shrink-0 text-[#6d826b]" /><p className="text-xs leading-5 text-[#667766]"><b className="text-[#3e5d43]">Waiting for sensor data.</b> Sample values are kept separate from this live view.</p></div><Button onClick={() => setSampleVisible(!sampleVisible)} variant="outline" testId="button-toggle-sample-readings">{sampleVisible ? 'Hide sample values' : 'View sample values'}</Button></div>}
    </Card>
    {sampleVisible && !hasRealReadings && <Card className="mt-5 border-[#e4d6ac]"><CardTitle icon={CircleHelp} title="Sample values — not live data" detail="Illustrative placeholders for interface demonstration only" aside={<Pill tone="amber">SAMPLE ONLY</Pill>} /><div className="grid gap-4 p-5 sm:grid-cols-3">{[['Body temperature', '38.6'], ['Pulse rate', '66'], ['Activity', '1,284']].map(([name, value]) => <div key={name} className="rounded-xl bg-[#f7f2df] p-4" data-testid={`sample-reading-${name.toLowerCase().replaceAll(' ', '-')}`}><p className="text-[10px] font-bold uppercase tracking-wider text-[#8b7c50]">{name}</p><p className="mt-3 font-serif text-3xl text-[#5d573e]">{value}</p><p className="mt-2 text-[10px] text-[#968b69]">Example only · not from a sensor</p></div>)}</div></Card>}
    {hasRealReadings && <Card className="mt-5"><CardTitle icon={Activity} title="Historical trend" detail="Graph contains real feed entries only" aside={<label className="text-[10px] text-[#768477]">Field <select value={chartField} onChange={(event) => setTrendField(event.target.value)} className="field-input compact ml-2 w-auto min-w-[130px]" data-testid="select-trend-field">{liveFields.map((field) => <option key={field} value={field}>{field}</option>)}</select></label>} /><div className="h-[290px] px-3 pb-4 pt-5" data-testid="chart-real-feed-trend"><ResponsiveContainer width="100%" height="100%"><LineChart data={chartData} margin={{ top: 8, right: 20, left: 0, bottom: 4 }}><CartesianGrid stroke="#e4e8de" strokeDasharray="3 4" /><XAxis dataKey="timestamp" tick={{ fill: '#7f8e7d', fontSize: 10 }} axisLine={{ stroke: '#d8dfd3' }} tickLine={false} /><YAxis tick={{ fill: '#7f8e7d', fontSize: 10 }} axisLine={false} tickLine={false} width={42} /><ChartTooltip contentStyle={{ borderRadius: 12, borderColor: '#dce3d7', background: '#fbfaf4', fontSize: 12 }} /><Line type="monotone" dataKey="value" stroke="#47724f" strokeWidth={2.5} dot={{ r: 3, fill: '#47724f', strokeWidth: 0 }} activeDot={{ r: 5 }} /></LineChart></ResponsiveContainer></div></Card>}
    <Card className="mt-5"><CardTitle icon={ClipboardList} title="Feed history" detail="All eight ThingSpeak fields, across returned real entries" aside={<span className="font-mono text-[10px] text-[#889487]">{response?.feeds.length || 0} entries</span>} />{response?.feeds?.length ? <div className="overflow-x-auto"><table className="w-full min-w-[1120px] text-left text-xs"><thead className="bg-[#f5f5ed] text-[9px] uppercase tracking-wider text-[#829082]"><tr><th className="px-5 py-3">Entry</th><th className="px-5 py-3">Created at</th>{allFields.map((field) => <th key={field} className="px-4 py-3">{response.channel[field as keyof typeof response.channel] || field}<span className="mt-1 block font-mono normal-case">{field}</span></th>)}</tr></thead><tbody>{response.feeds.slice().sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).map((entry) => <tr key={entry.entry_id} className="border-t border-[#edf0e8]" data-testid={`row-feed-${entry.entry_id}`}><td className="px-5 py-3 font-mono">#{entry.entry_id}</td><td className="px-5 py-3 text-[#778477]">{new Date(entry.created_at).toLocaleString()}</td>{allFields.map((field) => <td key={field} className="px-4 py-3">{entry[field as keyof ThingSpeakFeed] || '—'}</td>)}</tr>)}</tbody></table></div> : <EmptyState icon={Activity} title="No real feed history yet" text={configured ? 'The last successful read returned no sensor entries.' : 'Connect a ThingSpeak channel to populate real readings and entry history.'} href="/thingspeak" link="Configure channel" />}</Card>
  </div>;
}

function ThingSpeakPage({ data, update, feed, setFeed, readApiKey, setReadApiKey }: { data: FarmData; update: (next: FarmData | ((old: FarmData) => FarmData)) => void; feed: ThingSpeakFeedResponse | null; setFeed: (value: ThingSpeakFeedResponse | null) => void; readApiKey: string; setReadApiKey: (value: string) => void }) {
  const [channel, setChannel] = useState(data.config.channelId);
  const response = feed;
  const connected = Boolean(feed);
  const [error, setError] = useState('');
  const { mutate, isPending } = useReadThingSpeakFeeds();
  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (!channel.trim()) { setError('Enter a ThingSpeak channel ID.'); return; }
    setError('');
    mutate({ data: { channelId: channel.trim(), ...(readApiKey.trim() ? { readApiKey: readApiKey.trim() } : {}), results: 30 } }, {
      onSuccess: (value) => {
        setFeed(value);
        update((old) => ({ ...old, config: { ...old.config, channelId: channel.trim() } }));
      },
      onError: (requestError) => setError(apiErrorMessage(requestError)),
    });
  };
  const disconnect = () => { setFeed(null); setReadApiKey(''); update((old) => ({ ...old, config: { ...old.config, channelId: '' } })); setChannel(''); };
  const header = connected && response ? response.channel.name || `Channel ${response.channel.id || channel}` : 'Not connected';
  const availableFields = response ? Array.from({ length: 8 }, (_, index) => `field${index + 1}`).filter((field) => {
    const hasLabel = Boolean(response.channel[field as keyof typeof response.channel]);
    const hasValue = response.feeds.some((entry) => {
      const value = entry[field as keyof ThingSpeakFeed];
      return value !== null && value !== undefined && value !== '';
    });
    return hasLabel || hasValue;
  }) : [];
  return <div className="page-enter">
    <PageHeading eyebrow="Integration / ThingSpeak" title="Bring in your channel." description="Channel ID and sensor assignments are stored locally. A private read key stays in memory and is never persisted." />
    <div className="grid gap-5 xl:grid-cols-[.88fr_1.12fr]">
      <Card><CardTitle icon={Cloud} title="Channel connection" detail="Read-only channel data via the project backend" aside={<Pill tone={connected ? 'live' : 'amber'}>{connected ? 'Connected' : 'Not connected'}</Pill>} />
        <form onSubmit={connect} className="space-y-4 p-5">
          <label className="field-label">ThingSpeak channel ID<input className="field-input" value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="For example, 2481736" data-testid="input-channel-id" /></label>
          <label className="field-label">Read API key <span className="font-normal text-[#8c9689]">(optional for public channels)</span><input type="password" autoComplete="new-password" className="field-input font-mono" value={readApiKey} onChange={(e) => setReadApiKey(e.target.value)} placeholder="Needed for private channels" data-testid="input-read-api-key" /></label>
          <p className="flex gap-2 rounded-xl bg-[#f0f2e9] p-3 text-[11px] leading-5 text-[#718071]"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-[#55775b]" />The key stays in in-memory React state only. It is included in later manual and automatic refresh requests, never written to local storage, and cleared when you disconnect.</p>
          {error && <p role="alert" className="text-xs text-[#a34c40]" data-testid="status-thingspeak-error">{error}</p>}
          <div className="flex flex-wrap gap-2"><Button type="submit" disabled={isPending} testId="button-connect-thingspeak"><Wifi size={14} />{isPending ? 'Connecting…' : connected ? 'Refresh channel' : 'Connect & read'}</Button>{connected && <Button onClick={disconnect} variant="outline" testId="button-disconnect-thingspeak"><CloudOff size={14} />Disconnect</Button>}</div>
        </form>
        {connected && response && <div className="mx-5 mb-5 rounded-2xl border border-[#dce7d6] bg-[#edf3e8] p-4" data-testid="status-channel-connected"><div className="flex items-center gap-2 text-xs font-semibold text-[#3f6846]"><Check size={15} />Latest request succeeded</div><p className="mt-2 text-[11px] text-[#718171]">{header} · {response.feeds.length} feed entries returned</p><p className="mt-1 text-[10px] text-[#829082]">A successful read confirms channel access for this request only; device transmission continuity is not guaranteed.</p></div>}
      </Card>
      <Card><CardTitle icon={Radio} title="Detected channel fields" detail="Read-only fields discovered from this channel" />
        {availableFields.length ? <div className="divide-y divide-[#edf0e8]">{availableFields.map((field) => {
          const label = response?.channel[field as keyof typeof response.channel];
          const sensor = data.sensors.find((item) => item.thingSpeakField === field);
          return <div key={field} className="flex items-center gap-3 px-5 py-3.5" data-testid={`detected-field-${field}`}><span className="flex h-8 w-14 items-center justify-center rounded-lg bg-[#edf1e6] font-mono text-[10px] font-bold text-[#3f6846]">{field}</span><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{label || field}</p><p className="mt-1 text-[10px] text-[#718071]">{sensor ? `Mapped to ${sensor.name}` : 'No sensor assigned'}</p></div><Pill tone={sensor ? 'sage' : 'plain'}>{sensor ? 'Mapped' : 'Available'}</Pill></div>;
        })}</div> : <EmptyState icon={Radio} title={connected ? 'No fields found' : 'Connect a channel'} text={connected ? 'This channel has no configured fields or feed values yet.' : 'Connect a ThingSpeak channel to discover its available fields.'} href="/sensors" link="Manage sensor mapping" />}
      </Card>
    </div>
    <div className="mt-5 grid gap-5 md:grid-cols-2">
      <Card><CardTitle icon={Radio} title="Connection boundaries" /><div className="space-y-3 p-5 text-xs leading-5 text-[#728073]"><p className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-[#66826a]" />Requests use the generated API mutation; browser code does not call ThingSpeak directly.</p><p className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-[#66826a]" />Channel ID and sensor-to-field assignments persist locally; the read key does not.</p><p className="flex gap-2"><CircleHelp size={14} className="mt-0.5 shrink-0 text-[#9b8344]" />An online channel is not evidence that a sensor is calibrated or that an animal is healthy.</p></div></Card>
      <Card><CardTitle icon={Cable} title="Configured sensor links" detail="Sensor-to-field mapping is managed on Sensors & mapping" /><div className="divide-y divide-[#edf0e8]">{data.sensors.length ? data.sensors.map((sensor) => <div key={sensor.id} className="flex items-center gap-3 px-5 py-3" data-testid={`thingspeak-sensor-${sensor.id}`}><span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#edf1e6] text-[#507457]"><Thermometer size={15} /></span><div className="flex-1"><p className="text-xs font-semibold">{sensor.name}</p><p className="mt-1 text-[10px] text-[#879287]">{sensor.thingSpeakField || 'unmapped'}</p></div><Pill tone={sensor.connectionStatus === 'connected' ? 'live' : 'plain'}>{sensor.connectionStatus}</Pill></div>) : <p className="p-5 text-xs text-[#879287]">No sensors have been added.</p>}</div></Card>
    </div>
  </div>;
}

function SensorsPage({ data, update }: { data: FarmData; update: (next: FarmData | ((old: FarmData) => FarmData)) => void }) {
  const [editor, setEditor] = useState<Sensor | null>(null);
  const [isNew, setIsNew] = useState(false);
  const blank = blankSensor();
  const save = (event: FormEvent, form: Sensor) => { event.preventDefault(); if (!form.name.trim()) return; const sensor = { ...form, id: form.id || crypto.randomUUID() }; update((old) => ({ ...old, sensors: isNew ? [...old.sensors, sensor] : old.sensors.map((x) => x.id === sensor.id ? sensor : x) })); setEditor(null); };
  const remove = (id: string) => { if (window.confirm('Delete this sensor record?')) update((old) => ({ ...old, sensors: old.sensors.filter((s) => s.id !== id) })); };
  return <div className="page-enter"><PageHeading eyebrow="Prototype setup / instrumentation" title="Sensors & mapping" description="Record planned sensor hardware and map each measurement to a channel field. A planned sensor is not a connected device." action={<Button onClick={() => { setEditor({ ...blank }); setIsNew(true); }} testId="button-add-sensor"><Plus size={15} />Add sensor</Button>} />
    <div className="mb-5 grid gap-4 sm:grid-cols-3"><Stat label="Sensor records" value={data.sensors.length.toString().padStart(2, '0')} detail="Planned or connected in the workspace" icon={Cpu} /><Stat label="Physically connected" value={data.sensors.filter((s) => s.connectionStatus === 'connected').length.toString().padStart(2, '0')} detail="Marked as connected by the project team" icon={Cable} tone="sage" /><Stat label="Field mappings" value={data.sensors.filter((s) => s.thingSpeakField).length.toString().padStart(2, '0')} detail="Configured channel field associations" icon={SlidersHorizontal} tone="gold" /></div>
     <Card><CardTitle icon={Cpu} title="Sensor register" detail="Ranges are only evaluated when explicitly enabled as project comparisons" /><div className="overflow-x-auto"><table className="w-full min-w-[800px] text-left text-xs"><thead className="bg-[#f5f5ed] text-[10px] uppercase tracking-wider text-[#526553]"><tr><th className="px-5 py-3">Sensor</th><th className="px-4 py-3">Animal</th><th className="px-4 py-3">Threshold range</th><th className="px-4 py-3">ThingSpeak</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Actions</th></tr></thead><tbody>{data.sensors.map((sensor) => <tr key={sensor.id} className="border-t border-[#edf0e8]" data-testid={`row-sensor-${sensor.id}`}><td className="px-5 py-4"><p className="font-semibold">{sensor.name}</p><p className="mt-1 font-mono text-[10px] text-[#526553]">{sensor.type} · {sensor.sensorId || 'no ID'}</p></td><td className="px-4 py-4">{data.cattle.find((c) => c.id === sensor.animalId)?.name || <span className="text-[#526553]">Unassigned</span>}</td><td className="px-4 py-4 font-mono text-[11px]">{sensor.thresholdsConfigured ? `${sensor.normalMin}–${sensor.normalMax}` : 'Not configured'}</td><td className="px-4 py-4 font-mono text-[11px]">{sensor.thingSpeakField || '—'}</td><td className="px-4 py-4"><Pill tone={sensor.connectionStatus === 'connected' ? 'live' : 'plain'}>{sensor.connectionStatus}</Pill></td><td className="px-4 py-4"><div className="flex gap-1"><IconButton label={`Edit ${sensor.name}`} onClick={() => { setEditor({ ...sensor }); setIsNew(false); }} testId={`button-edit-sensor-${sensor.id}`}><Pencil size={14} /></IconButton><IconButton label={`Delete ${sensor.name}`} onClick={() => remove(sensor.id)} testId={`button-delete-sensor-${sensor.id}`}><Trash2 size={14} /></IconButton></div></td></tr>)}</tbody></table></div>{!data.sensors.length && <EmptyState icon={Cpu} title="No sensors recorded" text="Add a sensor record to plan sensor hardware and channel mapping." action={<Button onClick={() => { setEditor({ ...blank }); setIsNew(true); }} testId="button-empty-add-sensor"><Plus size={14} />Add sensor</Button>} />}</Card>
    <p className="mt-4 flex items-start gap-2 text-[11px] leading-5 text-[#829082]"><CircleHelp size={14} className="mt-0.5 shrink-0" />Thresholds shown here only support comparison with available readings; they are not veterinary guidance or diagnosis.</p>
    {editor && <SensorForm editor={editor} data={data} title={isNew ? 'Add a sensor' : 'Edit sensor'} onSave={save} onClose={() => setEditor(null)} />}
  </div>;
}

function CattlePage({ data, update, feed }: { data: FarmData; update: (next: FarmData | ((old: FarmData) => FarmData)) => void; feed: ThingSpeakFeedResponse | null }) {
  const [editor, setEditor] = useState<Cattle | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [selected, setSelected] = useState('');
  const blank: Cattle = { id: '', cattleId: '', name: '', breed: '', age: 1 };
  const save = (event: FormEvent) => { event.preventDefault(); if (!editor?.name.trim()) return; const cow = { ...editor, id: editor.id || crypto.randomUUID() }; update((old) => ({ ...old, cattle: isNew ? [...old.cattle, cow] : old.cattle.map((c) => c.id === cow.id ? cow : c) })); setEditor(null); };
  const remove = (id: string) => { if (window.confirm('Delete this animal profile? Sensor assignments to this animal will be cleared.')) update((old) => ({ ...old, cattle: old.cattle.filter((c) => c.id !== id), sensors: old.sensors.map((s) => s.animalId === id ? { ...s, animalId: '' } : s) })); if (selected === id) setSelected(''); };
  const animal = data.cattle.find((cow) => cow.id === selected);
  return <div className="page-enter"><PageHeading eyebrow="Farm records / herd" title="Cattle profiles" description="Organize animal profiles and see which project sensors are assigned. Profiles are not medical records." action={<Button onClick={() => { setEditor({ ...blank }); setIsNew(true); }} testId="button-add-cattle"><Plus size={15} />Add animal</Button>} />
    <div className="grid gap-4 lg:grid-cols-[1.4fr_.8fr]">
      <div className="grid gap-4 sm:grid-cols-2">{data.cattle.map((cow, index) => { const attached = data.sensors.filter((s) => s.animalId === cow.id); return <Card key={cow.id} className="overflow-hidden" ><button className="w-full text-left" onClick={() => setSelected(cow.id)} data-testid={`card-cattle-${cow.id}`}><div className={`h-2 ${index % 2 === 0 ? 'bg-[#859c74]' : 'bg-[#b2b98f]'}`} /><div className="p-5"><div className="flex items-start justify-between"><span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#e8eee2] font-serif text-xl text-[#527456]">{cow.name.slice(0, 1)}</span><span className="rounded-full bg-[#f0f1e8] px-2.5 py-1 text-[10px] text-[#788679]">{attached.length} sensor{attached.length === 1 ? '' : 's'}</span></div><h3 className="mt-5 font-serif text-2xl">{cow.name}</h3><p className="mt-1 text-xs text-[#849084]">{cow.breed} · {cow.age} years old</p><p className="mt-1 font-mono text-[10px] text-[#869285]">Cattle ID: {cow.cattleId || 'Not entered'}</p><div className="mt-5 flex items-center justify-between border-t border-[#edf0e8] pt-4"><span className="text-[10px] uppercase tracking-wider text-[#879287]">Assignments</span><span className="text-xs font-semibold text-[#547256]">{attached.length ? attached.map((s) => s.name).join(', ') : 'None'}</span></div></div></button><div className="flex justify-end gap-1 border-t border-[#edf0e8] px-4 py-2"><IconButton label={`Edit ${cow.name}`} onClick={() => { setEditor({ ...cow }); setIsNew(false); }} testId={`button-edit-cattle-${cow.id}`}><Pencil size={14} /></IconButton><IconButton label={`Delete ${cow.name}`} onClick={() => remove(cow.id)} testId={`button-delete-cattle-${cow.id}`}><Trash2 size={14} /></IconButton></div></Card>; })}{!data.cattle.length && <EmptyState icon={Users} title="No animal profiles" text="Add a profile to organize assignments for the project." action={<Button onClick={() => { setEditor({ ...blank }); setIsNew(true); }} testId="button-empty-add-cattle"><Plus size={14} />Add animal</Button>} />}</div>
      <Card className="min-h-[280px]"><CardTitle icon={HeartPulse} title={animal ? animal.name : 'Profile history'} detail={animal ? 'Project assignment overview' : 'Select an animal profile'} />{animal ? <div className="p-5"><div className="rounded-2xl bg-[#eef1e7] p-4"><p className="text-[10px] font-bold uppercase tracking-wider text-[#7c897b]">Profile</p><p className="mt-2 font-serif text-2xl">{animal.breed}</p><p className="mt-1 text-xs text-[#7d897c]">Age {animal.age} years · recorded in project</p></div><h4 className="mb-3 mt-5 text-[10px] font-bold uppercase tracking-[.15em] text-[#899487]">Sensor assignments</h4>{data.sensors.filter((s) => s.animalId === animal.id).length ? data.sensors.filter((s) => s.animalId === animal.id).map((sensor) => <div key={sensor.id} className="mb-2 flex items-center gap-3 rounded-xl border border-[#e5e8de] p-3" data-testid={`assignment-history-${sensor.id}`}><Thermometer size={15} className="text-[#638066]" /><div className="flex-1"><p className="text-xs font-semibold">{sensor.name}</p><p className="mt-1 text-[10px] text-[#859084]">{sensor.thingSpeakField || 'No channel field'} · {sensor.connectionStatus}</p></div></div>) : <p className="rounded-xl bg-[#f4f4ed] p-3 text-xs text-[#879287]">No sensor assignment recorded.</p>}<h4 className="mb-3 mt-5 text-[10px] font-bold uppercase tracking-[.15em] text-[#899487]">Recent real readings</h4>{feed?.feeds?.length ? data.sensors.filter((s) => s.animalId === animal.id && s.thingSpeakField).map((sensor) => { const latestFeed = feed.feeds[feed.feeds.length - 1]; const reading = latestFeed?.[sensor.thingSpeakField as keyof ThingSpeakFeed]; return <div key={sensor.id} className="mb-2 flex items-center justify-between rounded-xl bg-[#edf3e8] p-3" data-testid={`cattle-reading-${sensor.id}`}><div><p className="text-xs font-semibold">{sensor.name}</p><p className="mt-1 text-[10px] text-[#7e8d7f]">{latestFeed?.created_at ? new Date(latestFeed.created_at).toLocaleString() : 'ThingSpeak entry'}</p></div><p className="font-mono text-sm text-[#456a4b]">{reading || '—'}</p></div>; }) : <p className="rounded-xl bg-[#f4f4ed] p-3 text-xs leading-5 text-[#879287]">No real feed entries available for this profile. Connect a channel and map a field to view readings; sample data is not included in this history.</p>}<p className="mt-4 text-[10px] leading-4 text-[#8b968a]">Sensor readings are observations only. No health history or diagnosis is inferred.</p></div> : <div className="p-5"><div className="flex h-36 flex-col items-center justify-center rounded-2xl bg-[#f1f2eb] text-center"><Users size={22} className="text-[#849582}" /><p className="mt-3 text-xs font-semibold">Choose a profile</p><p className="mt-1 max-w-[230px] text-[10px] leading-4 text-[#879287]">Select an animal to review sensor assignments and history status.</p></div></div>}</Card>
    </div>
    {editor && <Modal title={isNew ? 'Add animal profile' : 'Edit animal profile'} onClose={() => setEditor(null)}><form onSubmit={save} className="space-y-3"><Field label="Cattle ID (your farm identifier)"><input required className="field-input font-mono" value={editor.cattleId} onChange={(e) => setEditor({ ...editor, cattleId: e.target.value })} placeholder="e.g. C-014" data-testid="input-cattle-id" /></Field><Field label="Name"><input required className="field-input" value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} data-testid="input-cattle-name" /></Field><Field label="Breed"><input className="field-input" value={editor.breed} onChange={(e) => setEditor({ ...editor, breed: e.target.value })} data-testid="input-cattle-breed" /></Field><Field label="Age in years"><input type="number" min="0" step="1" className="field-input" value={editor.age} onChange={(e) => setEditor({ ...editor, age: Number(e.target.value) })} data-testid="input-cattle-age" /></Field><p className="text-[10px] text-[#889487]">Sensor assignments use a separate internal profile key that remains stable when this farm ID is edited.</p><div className="flex justify-end gap-2 pt-2"><Button variant="outline" onClick={() => setEditor(null)} testId="button-cancel-cattle">Cancel</Button><Button type="submit" testId="button-save-cattle">Save profile</Button></div></form></Modal>}
  </div>;
}

function AlertsPage({ data, feed }: { data: FarmData; feed: ThingSpeakFeedResponse | null }) {
  const latest = feed?.feeds?.length ? latestFeedEntry(feed.feeds) : null;
  const evaluated = latest ? data.sensors.flatMap((sensor) => {
    if (!sensor.thingSpeakField) return [];
    const raw = latest[sensor.thingSpeakField as keyof ThingSpeakFeed];
    const status = getProjectStatus(sensor, typeof raw === 'string' ? raw : null);
    if (!status) return [];
    const cow = data.cattle.find((animal) => animal.id === sensor.animalId);
    return [{ sensor, cattleId: cow?.cattleId || 'Unassigned', reading: raw, status, timestamp: latest.created_at }];
  }) : [];
  return <div className="page-enter"><PageHeading eyebrow="Monitoring / thresholds" title="Threshold alerts" description="Review project-defined ranges for mapped measurements. These thresholds are not veterinary standards or diagnoses." />
    <div className="mb-5 flex items-start gap-3 rounded-2xl border border-[#e6d7b5] bg-[#f7f1df] p-4" data-testid="alert-veterinary-disclaimer"><AlertTriangle size={17} className="mt-0.5 shrink-0 text-[#8d7846]" /><div><p className="text-xs font-bold text-[#62593d]">Alerts are not veterinary diagnoses.</p><p className="mt-1 text-xs leading-5 text-[#807653]">A threshold comparison is a software notice only. It does not diagnose, predict illness, or replace veterinary advice. Seek professional care for animal health concerns.</p></div></div>
    <Card><CardTitle icon={AlertTriangle} title="Latest mapped sensor checks" detail="Computed from the latest actual ThingSpeak entry only" aside={<Pill tone={latest ? 'live' : 'amber'}>{latest ? `${evaluated.length} evaluated` : 'Waiting for real data'}</Pill>} />
      {!latest ? <div className="flex items-start gap-3 p-5"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f3edda] text-[#8b7645]"><Clock3 size={17} /></span><div><p className="text-sm font-semibold">Waiting for live measurements</p><p className="mt-1 max-w-2xl text-xs leading-5 text-[#788579]">No sample values are used here. Connect ThingSpeak and map a sensor field before project thresholds can be compared.</p></div></div> : evaluated.length ? <div className="overflow-x-auto"><table className="w-full min-w-[800px] text-left text-xs"><thead className="bg-[#f5f5ed] text-[9px] uppercase tracking-wider text-[#829082]"><tr><th className="px-5 py-3">Status</th><th className="px-4 py-3">Sensor</th><th className="px-4 py-3">Cattle ID</th><th className="px-4 py-3">Reading</th><th className="px-4 py-3">Timestamp</th><th className="px-4 py-3">Reason</th></tr></thead><tbody>{evaluated.map(({ sensor, cattleId, reading, status, timestamp }) => <tr key={sensor.id} className="border-t border-[#edf0e8]" data-testid={`alert-reading-${sensor.id}`}><td className="px-5 py-3"><Pill tone={status.status === 'critical' ? 'red' : status.status === 'warning' ? 'amber' : 'live'}>{status.status}</Pill></td><td className="px-4 py-3"><p className="font-semibold">{sensor.name}</p><p className="mt-1 text-[10px] text-[#849084]">{sensor.thingSpeakField}</p></td><td className="px-4 py-3 font-mono">{cattleId}</td><td className="px-4 py-3 font-mono">{reading}</td><td className="px-4 py-3 text-[#778477]">{new Date(timestamp).toLocaleString()}</td><td className="max-w-[240px] px-4 py-3 text-[#778477]">{status.reason}</td></tr>)}</tbody></table>{!evaluated.length && <p className="p-5 text-xs text-[#829082]">No mapped feed values are available to evaluate in the latest entry.</p>}</div> : <div className="p-5 text-xs text-[#829082]">No mapped feed values are available to evaluate in the latest entry.</div>}
    </Card>
    <Card className="mt-5"><CardTitle icon={SlidersHorizontal} title="Configured project comparison values" detail="Edit normal and optional critical bounds in Sensors & mapping" aside={<Link href="/sensors" className="text-[11px] font-semibold text-[#4b7053]" data-testid="link-edit-thresholds">Edit thresholds <ArrowRight size={13} className="inline" /></Link>} />{data.sensors.length ? <div className="divide-y divide-[#edf0e8]">{data.sensors.map((sensor) => <div key={sensor.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[1.1fr_.8fr_.8fr] sm:items-center" data-testid={`threshold-${sensor.id}`}><div><p className="text-xs font-semibold">{sensor.name}</p><p className="mt-1 text-[10px] text-[#879287]">{sensor.name} · {sensor.type || 'sensor type not specified'}</p></div><div><p className="text-[9px] font-bold uppercase tracking-wider text-[#879287]">Normal comparison range</p><p className="mt-1 font-mono text-xs">{sensor.thresholdsConfigured ? `${sensor.normalMin}–${sensor.normalMax}` : 'Not configured'}</p></div><div><p className="text-[9px] font-bold uppercase tracking-wider text-[#879287]">Optional critical bounds</p><p className="mt-1 font-mono text-xs">{sensor.thresholdsConfigured ? `${sensor.criticalMin ?? '—'} to ${sensor.criticalMax ?? '—'}` : 'Not configured'}</p></div></div>)}</div> : <EmptyState icon={AlertTriangle} title="No thresholds configured" text="Add sensor records and define project comparison ranges." href="/sensors" link="Set up sensors" />}</Card>
    <p className="mt-4 text-[11px] leading-5 text-[#829082]">Normal, warning, and critical labels are comparisons against values configured by the project user. They are not clinical rules, veterinary guidance, diagnoses, or forecasts.</p>
  </div>;
}

function AboutPage() {
  return <div className="page-enter"><PageHeading eyebrow="Project / field guide" title="About our prototype" description="CattleCare is a student-built IoT prototype exploring organized cattle-health monitoring for Indian dairy farms." />
    <div className="relative overflow-hidden rounded-[26px] bg-[#254b36] p-6 text-[#f2f1e7] md:p-9"><div className="absolute -right-12 -top-16 h-72 w-72 rounded-full border border-[#789477]/50" /><div className="absolute -right-2 top-[-28px] h-52 w-52 rounded-full border border-[#789477]/40" /><p className="relative text-[10px] font-bold uppercase tracking-[.2em] text-[#b1c6a8]">Objective · learn, measure, display</p><h2 className="relative mt-4 max-w-2xl font-serif text-4xl leading-[1.04] tracking-[-.04em] md:text-5xl">A practical path from sensor signal to informed attention.</h2><p className="relative mt-4 max-w-2xl text-sm leading-6 text-[#d0ddc8]">Our objective is to prototype how low-cost connected hardware could help students and farm teams organize cattle observations. The system can gather body, activity, and environmental measurements, then show actual transmitted readings clearly. It is an educational prototype, not a veterinary medical device.</p></div>
    <div className="mt-5 grid gap-4 md:grid-cols-3">{[
      { n: '01', title: 'Collect', text: 'Planned sensors can collect body-temperature and pulse signals, motion/activity data, and surrounding temperature or humidity. Accuracy depends on hardware fit, calibration, and testing.', icon: Thermometer, tone: 'sage' },
      { n: '02', title: 'Transmit', text: 'An ESP32 reads connected sensor outputs and, when the physical build and Wi-Fi are working, publishes mapped values to a ThingSpeak channel.', icon: Wifi, tone: 'gold' },
      { n: '03', title: 'Display', text: 'CattleCare reads channel feeds through the project backend and displays real values, timestamps, field history, and user-configured comparisons. Without a feed it waits; it does not substitute sample data.', icon: Activity, tone: 'green' },
    ].map((step) => <Card key={step.n} className="p-5"><div className="flex items-center justify-between"><span className="font-mono text-xs text-[#8c988a]">{step.n} / PROCESS</span><step.icon size={17} className="text-[#638068]" /></div><h3 className="mt-7 font-serif text-2xl">{step.title}</h3><p className="mt-2 text-xs leading-5 text-[#788579]">{step.text}</p></Card>)}</div>
    <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_1fr]"><Card><CardTitle icon={Radio} title="Physical vs. planned status" /><div className="space-y-3 p-5"><div className="flex items-start gap-3"><Pill tone="plain">Planned</Pill><p className="text-xs leading-5 text-[#788579]">A future component or sensor record. It does not indicate that hardware exists or is transmitting.</p></div><div className="flex items-start gap-3"><Pill tone="sage">Available</Pill><p className="text-xs leading-5 text-[#788579]">A component marked on hand for the student project. It does not imply a working sensor.</p></div><div className="flex items-start gap-3"><Pill tone="live">Connected</Pill><p className="text-xs leading-5 text-[#788579]">A manual project status. Real readings still require a successful ThingSpeak feed request.</p></div><div className="flex items-start gap-3"><Pill tone="amber">Waiting for data</Pill><p className="text-xs leading-5 text-[#788579]">No feed response is currently available to display as live measurement data.</p></div></div></Card><Card><CardTitle icon={Stethoscope} title="Limits and responsible use" /><div className="space-y-3 p-5 text-xs leading-5 text-[#788579]"><p>Unusual readings can signal a need for attention and may warrant checking the animal, sensor placement, and data quality.</p><p>They are not diagnoses, forecasts, clinical reference ranges, or a replacement for veterinary judgment. Thresholds are user-configured project comparisons.</p><p>Prototype sensors require appropriate calibration and validation. Consult a qualified veterinarian for health concerns and care decisions.</p></div></Card></div>
  </div>;
}

function SettingsPage({ data, update }: { data: FarmData; update: (next: FarmData | ((old: FarmData) => FarmData)) => void }) {
  const [saved, setSaved] = useState(false);
  const saveInterval = (value: number) => { update((old) => ({ ...old, config: { ...old.config, refreshSeconds: value } })); setSaved(true); window.setTimeout(() => setSaved(false), 1800); };
  const saveAutoRefresh = (enabled: boolean) => { update((old) => ({ ...old, config: { ...old.config, autoRefreshEnabled: enabled } })); setSaved(true); window.setTimeout(() => setSaved(false), 1800); };
  return <div className="page-enter"><PageHeading eyebrow="Workspace / preferences" title="Settings" description="Project configuration is local to this browser; the private channel key is never persisted." />
    <div className="grid gap-5 lg:grid-cols-[1.05fr_.95fr]">
      <Card><CardTitle icon={RefreshCw} title="Feed refresh" detail="Controls requests while Live readings is open" /><div className="space-y-5 p-5"><label className="flex items-center justify-between gap-4 rounded-xl bg-[#f0f2e9] p-4"><span><span className="block text-xs font-semibold">Automatic refresh</span><span className="mt-1 block text-[10px] text-[#7b887b]">{data.config.autoRefreshEnabled ? 'On · requests run while the live page is open' : 'Off · refresh manually when needed'}</span></span><input type="checkbox" role="switch" checked={data.config.autoRefreshEnabled} onChange={(e) => saveAutoRefresh(e.target.checked)} className="h-5 w-5 accent-[#315c42]" data-testid="toggle-auto-refresh" /></label><label className="field-label max-w-sm">Refresh frequency<select value={data.config.refreshSeconds} disabled={!data.config.autoRefreshEnabled} onChange={(e) => saveInterval(Number(e.target.value))} className="field-input disabled:opacity-45" data-testid="select-refresh-interval"><option value="15">Every 15 seconds</option><option value="30">Every 30 seconds</option><option value="60">Every 60 seconds</option><option value="300">Every 5 minutes</option></select></label><p className="text-[11px] leading-5 text-[#829082]">Each request uses the generated API mutation. The interval does not create data or indicate transmission between requests. A private-channel key remains only in page memory and is sent on every refresh.</p>{saved && <p className="flex items-center gap-2 text-xs font-semibold text-[#4b7652]" data-testid="status-settings-saved"><Check size={14} />Preference saved on this device</p>}</div></Card>
      <Card><CardTitle icon={Settings} title="Local configuration" detail="Stored in this browser's local storage" /><div className="divide-y divide-[#edf0e8]"><SettingRow label="ThingSpeak channel ID" value={data.config.channelId || 'Not configured'} /><SettingRow label="Sensor field assignments" value={`${data.sensors.filter((sensor) => sensor.thingSpeakField).length} mapped`} /><SettingRow label="Animal profiles" value={`${data.cattle.length} profile${data.cattle.length === 1 ? '' : 's'}`} /><SettingRow label="Sensor records" value={`${data.sensors.length} record${data.sensors.length === 1 ? '' : 's'}`} /><SettingRow label="Farm location" value={data.location.farmName || data.location.village || 'Not set'} /><SettingRow label="Private read API key" value="Not stored" highlight /></div></Card>
    </div>
     <Card className="mt-5"><CardTitle icon={ShieldCheck} title="Privacy & data boundaries" /><div className="grid gap-4 p-5 md:grid-cols-3"><div><p className="text-xs font-semibold">Project configuration</p><p className="mt-2 text-[11px] leading-5 text-[#7c897c]">Cattle profiles, sensors, farm location, and refresh preferences remain in browser storage.</p></div><div><p className="text-xs font-semibold">Private key</p><p className="mt-2 text-[11px] leading-5 text-[#7c897c]">The read key stays in React memory for subsequent private-channel requests, is never written to browser storage, and is cleared on disconnect or logout.</p></div><div><p className="text-xs font-semibold">Feed data</p><p className="mt-2 text-[11px] leading-5 text-[#7c897c]">Real feed readings live in page memory only; reloading the page returns to a waiting state until another request.</p></div></div></Card>
  </div>;
}

function LocationPage({ data, update }: { data: FarmData; update: (next: FarmData | ((old: FarmData) => FarmData)) => void }) {
  const [draft, setDraft] = useState(data.location);
  const [saved, setSaved] = useState(false);
  const setField = (field: keyof FarmLocation, value: string) => setDraft((current) => ({ ...current, [field]: value }));
  const save = (event: FormEvent) => {
    event.preventDefault();
    update((old) => ({ ...old, location: draft }));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2200);
  };
  const locationSummary = [draft.village, draft.district, draft.state].filter(Boolean).join(', ');
  const mapQuery = [draft.address, locationSummary].filter(Boolean).join(', ');
  return <div className="page-enter">
    <PageHeading eyebrow="Farm profile / location" title="Farm location" description="Record the farm's address and optional coordinates for project context. Details are entered manually and saved in this browser." />
    <div className="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
      <Card><CardTitle icon={MapPin} title="Location details" detail="No GPS access or background tracking" />
        <form onSubmit={save} className="space-y-4 p-5">
          <Field label="Farm name"><input className="field-input" value={draft.farmName} onChange={(event) => setField('farmName', event.target.value)} placeholder="e.g. Campus dairy unit" data-testid="input-farm-name" /></Field>
          <Field label="Street address"><textarea className="field-input min-h-[84px] resize-y" value={draft.address} onChange={(event) => setField('address', event.target.value)} placeholder="Building, road, or landmark" data-testid="input-farm-address" /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Village / town"><input className="field-input" value={draft.village} onChange={(event) => setField('village', event.target.value)} data-testid="input-farm-village" /></Field>
            <Field label="District"><input className="field-input" value={draft.district} onChange={(event) => setField('district', event.target.value)} data-testid="input-farm-district" /></Field>
            <Field label="State"><input className="field-input" value={draft.state} onChange={(event) => setField('state', event.target.value)} data-testid="input-farm-state" /></Field>
            <Field label="PIN code"><input inputMode="numeric" className="field-input" value={draft.postalCode} onChange={(event) => setField('postalCode', event.target.value)} data-testid="input-farm-pin" /></Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Latitude (optional)"><input type="number" min="-90" max="90" step="any" className="field-input" value={draft.latitude} onChange={(event) => setField('latitude', event.target.value)} placeholder="e.g. 12.9716" data-testid="input-farm-latitude" /></Field>
            <Field label="Longitude (optional)"><input type="number" min="-180" max="180" step="any" className="field-input" value={draft.longitude} onChange={(event) => setField('longitude', event.target.value)} placeholder="e.g. 77.5946" data-testid="input-farm-longitude" /></Field>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#e8eadf] pt-4">
            <p className="text-xs text-[#526553]">{saved ? 'Location saved on this device.' : 'Location is optional and is not shared with ThingSpeak.'}</p>
            <Button type="submit" testId="button-save-location"><Check size={14} />Save location</Button>
          </div>
        </form>
      </Card>
      <Card className="overflow-hidden">
        <div className="flex min-h-[330px] flex-col justify-between bg-[#e9eee2] p-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#315c42] text-white"><MapPin size={22} /></div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[.16em] text-[#405943]">Saved farm location</p>
            <h3 className="mt-3 font-serif text-3xl text-[#243f2f]">{draft.farmName || 'Farm name not set'}</h3>
            <p className="mt-2 text-sm leading-6 text-[#405943]">{locationSummary || 'Add a village, district, or state to see the location summary here.'}</p>
            {draft.address && <p className="mt-2 text-xs leading-5 text-[#526553]">{draft.address}</p>}
            {mapQuery && <a className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[#315c42] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#254b36]" href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(mapQuery)}`} target="_blank" rel="noreferrer" data-testid="link-location-map"><MapPin size={14} />Search this location on map</a>}
            {(draft.latitude || draft.longitude) && <p className="mt-4 font-mono text-xs font-semibold text-[#315c42]">{draft.latitude || '—'}°, {draft.longitude || '—'}°</p>}
          </div>
          <p className="text-xs leading-5 text-[#526553]">Location helps identify the farm workspace. CattleCare does not automatically track animals or claim to show a live map.</p>
        </div>
      </Card>
    </div>
  </div>;
}

function SettingRow({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return <div className="flex items-center justify-between gap-3 px-5 py-3.5" data-testid={`setting-${label.toLowerCase().replaceAll(' ', '-')}`}><span className="text-xs text-[#748174]">{label}</span><span className={`text-right text-xs font-semibold ${highlight ? 'text-[#4c7652]' : 'text-[#405943]'}`}>{value}</span></div>;
}

function EmptyState({ icon: Icon, title, text, href, link, action }: { icon: typeof Activity; title: string; text: string; href?: string; link?: string; action?: ReactNode }) {
  return <div className="flex min-h-[220px] flex-col items-center justify-center px-6 py-10 text-center" data-testid="empty-state"><span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#edf1e6] text-[#648069]"><Icon size={21} /></span><h3 className="mt-4 font-serif text-xl">{title}</h3><p className="mt-2 max-w-sm text-xs leading-5 text-[#829082]">{text}</p>{action || (href && <Link href={href} className="mt-4 inline-flex items-center gap-2 text-xs font-bold text-[#3f6847]" data-testid="link-empty-state">{link || 'Open'} <ArrowRight size={14} /></Link>)}</div>;
}
function IconButton({ children, label, onClick, testId }: { children: ReactNode; label: string; onClick: () => void; testId: string }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} className="flex h-8 w-8 items-center justify-center rounded-lg text-[#758377] hover:bg-[#edf1e7] hover:text-[#315c42]" data-testid={testId}>{children}</button>;
}
function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [onClose]);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1b3025]/40 p-4 backdrop-blur-[2px]" onClick={onClose} data-testid="dialog-backdrop"><div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} className="max-h-[90dvh] w-full max-w-[540px] overflow-y-auto rounded-[22px] border border-[#e0e4d9] bg-[#fbfaf4] p-5 shadow-[0_24px_80px_rgba(22,45,29,.2)] md:p-6" data-testid="dialog-editor"><div className="mb-5 flex items-center justify-between"><h2 className="font-serif text-2xl">{title}</h2><button onClick={onClose} aria-label="Close dialog" className="rounded-lg p-2 text-[#758377] hover:bg-[#edf1e7]" data-testid="button-close-dialog"><X size={18} /></button></div>{children}</div></div>;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field-label">{label}{children}</label>;
}
function SensorForm({ editor, data, title, onSave, onClose }: { editor: Sensor; data: FarmData; title: string; onSave: (event: FormEvent, form: Sensor) => void; onClose: () => void }) {
  const [form, setForm] = useState(editor);
  const change = (key: keyof Sensor, value: string | number | boolean | undefined) => setForm((old) => ({
    ...old,
    [key]: value,
    ...(['normalMin', 'normalMax', 'criticalMin', 'criticalMax'].includes(key) ? { thresholdsConfigured: true } : {}),
  }));
  return <Modal title={title} onClose={onClose}>
    <form onSubmit={(event) => onSave(event, form)} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Sensor name"><input required className="field-input" value={form.name} onChange={(e) => change('name', e.target.value)} data-testid="input-sensor-name" /></Field>
        <Field label="Sensor type"><input className="field-input" value={form.type} onChange={(e) => change('type', e.target.value)} placeholder="e.g. DS18B20" data-testid="input-sensor-type" /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Sensor ID"><input className="field-input" value={form.sensorId} onChange={(e) => change('sensorId', e.target.value)} data-testid="input-sensor-id" /></Field>
        <Field label="Animal assignment"><select className="field-input" value={form.animalId} onChange={(e) => change('animalId', e.target.value)} data-testid="select-sensor-animal"><option value="">Unassigned</option>{data.cattle.map((cow) => <option key={cow.id} value={cow.id}>{cow.cattleId ? `${cow.name} · ${cow.cattleId}` : cow.name}</option>)}</select></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Project normal minimum"><input type="number" step="any" className="field-input" value={form.normalMin} onChange={(e) => change('normalMin', Number(e.target.value))} data-testid="input-sensor-min" /></Field>
        <Field label="Project normal maximum"><input type="number" step="any" className="field-input" value={form.normalMax} onChange={(e) => change('normalMax', Number(e.target.value))} data-testid="input-sensor-max" /></Field>
      </div>
      <label className="flex items-center gap-3 rounded-xl bg-[#f0f2e9] p-3 text-xs font-semibold text-[#5e735f]"><input type="checkbox" checked={Boolean(form.thresholdsConfigured)} onChange={(e) => change('thresholdsConfigured', e.target.checked)} className="h-4 w-4 accent-[#315c42]" data-testid="toggle-sensor-thresholds" />Enable this user-configured project comparison</label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Critical minimum (optional)"><input type="number" step="any" className="field-input" value={form.criticalMin ?? ''} onChange={(e) => change('criticalMin', e.target.value === '' ? undefined : Number(e.target.value))} data-testid="input-sensor-critical-min" /></Field>
        <Field label="Critical maximum (optional)"><input type="number" step="any" className="field-input" value={form.criticalMax ?? ''} onChange={(e) => change('criticalMax', e.target.value === '' ? undefined : Number(e.target.value))} data-testid="input-sensor-critical-max" /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="ThingSpeak field"><select className="field-input" value={form.thingSpeakField} onChange={(e) => change('thingSpeakField', e.target.value)} data-testid="select-sensor-field"><option value="">Not mapped</option>{Array.from({ length: 8 }, (_, index) => `field${index + 1}`).map((field) => <option key={field} value={field}>{field}</option>)}</select></Field>
        <Field label="Connection status"><select className="field-input" value={form.connectionStatus} onChange={(e) => change('connectionStatus', e.target.value as Sensor['connectionStatus'])} data-testid="select-sensor-status"><option value="planned">Planned</option><option value="connected">Physically connected</option></select></Field>
      </div>
      <p className="text-[10px] leading-4 text-[#829082]">Normal and critical values are project-configured comparison values, not veterinary guidance.</p>
      <div className="flex justify-end gap-2 pt-2"><Button variant="outline" onClick={onClose} testId="button-cancel-sensor">Cancel</Button><Button type="submit" testId="button-save-sensor">Save sensor</Button></div>
    </form>
  </Modal>;
}
function LoadingScreen() {
  return <div className="min-h-[100dvh] bg-[#f3f2e9] p-6" aria-label="Loading workspace"><div className="mx-auto max-w-5xl space-y-5"><div className="skeleton h-12 w-52" /><div className="skeleton h-36 w-full" /><div className="grid gap-4 sm:grid-cols-3"><div className="skeleton h-28" /><div className="skeleton h-28" /><div className="skeleton h-28" /></div></div></div>;
}

export default App;

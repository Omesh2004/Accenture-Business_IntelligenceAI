import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { authOptions } from '../auth/[...nextauth]/route';
import { SUPPORTED_RBAC_APPS } from '@/lib/feature-map';

const execFileAsync = promisify(execFile);
const SUPPORTED_APPS = new Set(SUPPORTED_RBAC_APPS);

function resolveByWalkingUp(relativePath: string, maxLevels = 8) {
  const attempted: string[] = [];
  let base = process.cwd();

  for (let i = 0; i <= maxLevels; i += 1) {
    const candidate = path.resolve(base, relativePath);
    attempted.push(candidate);
    if (fs.existsSync(candidate)) {
      return { path: candidate, attempted };
    }
    const parent = path.dirname(base);
    if (parent === base) break;
    base = parent;
  }

  return { path: attempted[0], attempted };
}

function getRbacFilePath() {
  return resolveByWalkingUp('rbac.json').path;
}

function getLookupScriptPath() {
  return resolveByWalkingUp(path.join('scripts', 'nexbank_user_lookup.py')).path;
}

function normalizeEmail(email: string) {
  return String(email || '').trim().toLowerCase();
}

async function runLookupPromotion(email: string) {
  const scriptResolution = resolveByWalkingUp(path.join('scripts', 'nexbank_user_lookup.py'));
  const scriptPath = scriptResolution.path;
  console.log(`[RBAC] Resolved script path: ${scriptPath}`);
  console.log(`[RBAC] Attempted paths: ${scriptResolution.attempted.join(' | ')}`);
  console.log(`[RBAC] process.cwd() = ${process.cwd()}`);

  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      found: false,
      message: `Lookup script not found. Attempted: ${scriptResolution.attempted.join(' | ')}`,
    };
  }

  const isWin = process.platform === 'win32';
  const workspaceRoot = path.dirname(path.dirname(scriptPath));
  const relativeScriptPath = path.relative(workspaceRoot, scriptPath);

  console.log(`[RBAC] Workspace root: ${workspaceRoot}`);
  console.log(`[RBAC] Relative script path: ${relativeScriptPath}`);

  const candidates: Array<{ cmd: string; args: string[] }> = isWin
    ? [
        { cmd: 'py', args: ['-3', relativeScriptPath, email, '--json'] },
        { cmd: 'python', args: [relativeScriptPath, email, '--json'] },
      ]
    : [
        { cmd: 'python3', args: [relativeScriptPath, email, '--json'] },
        { cmd: 'python', args: [relativeScriptPath, email, '--json'] },
      ];

  let lastErr: unknown = null;
  for (const candidate of candidates) {
    try {
      console.log(`[RBAC] Attempting: ${candidate.cmd} ${candidate.args.join(' ')}`);
      const { stdout } = await execFileAsync(candidate.cmd, candidate.args, {
        timeout: 25000,
        windowsHide: true,
        cwd: workspaceRoot,
      });
      console.log(`[RBAC] Script execution succeeded, stdout: ${stdout?.substring(0, 200)}`);
      const parsed = JSON.parse(String(stdout || '{}')) as {
        found?: boolean;
        promoted?: boolean;
        already_admin?: boolean;
        error?: string;
      };
      if (parsed.found) {
        return {
          ok: true,
          found: true,
          promoted: Boolean(parsed.promoted),
          already_admin: Boolean(parsed.already_admin),
        };
      }
      return {
        ok: false,
        found: false,
        message: parsed.error || 'Email not found in tenant database',
      };
    } catch (err) {
      const errMsg = (err as Error)?.message || String(err);
      const stdout = (err as { stdout?: string }).stdout;
      console.log(`[RBAC] Execution failed with ${candidate.cmd}: ${errMsg}${stdout ? ` | stdout: ${stdout.substring(0, 100)}` : ''}`);
      lastErr = err;
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') {
        continue;
      }
      try {
        const parsed = JSON.parse(String(stdout || '{}')) as { found?: boolean; error?: string };
        if (parsed.found === false) {
          return {
            ok: false,
            found: false,
            message: parsed.error || 'Email not found in tenant database',
          };
        }
      } catch {
        // Ignore parse errors and continue with fallback message.
      }
      return { ok: false, found: false, message: 'Lookup script execution failed' };
    }
  }

  return {
    ok: false,
    found: false,
    message: `Python runtime unavailable: ${String((lastErr as { message?: string })?.message || 'unknown error')}`,
  };
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user || session.user.role !== 'super_admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const configPath = getRbacFilePath();
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      return NextResponse.json(JSON.parse(data));
    }
    return NextResponse.json({ super_admins: [], app_admins: {} });
  } catch (e) {
    return NextResponse.json({ error: 'Failed to read config' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user || session.user.role !== 'super_admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { action, email, appId } = body;
    const normalizedEmail = normalizeEmail(email);
    const normalizedAppId = String(appId || '').trim().toLowerCase();

    // Validate payload
    if (!normalizedEmail || !normalizedAppId || !['add', 'remove'].includes(action)) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }

    if (!SUPPORTED_APPS.has(normalizedAppId)) {
      return NextResponse.json({ error: `Supported apps: ${Array.from(SUPPORTED_APPS).join(', ')}` }, { status: 400 });
    }

    const configPath = getRbacFilePath();
    let config = { super_admins: [], app_admins: {} as Record<string, string[]> };

    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }

    if (!config.app_admins[normalizedAppId]) {
      config.app_admins[normalizedAppId] = [];
    }

    let promotion: Record<string, unknown> | null = null;

    if (action === 'add') {
      const lookupResult = await runLookupPromotion(normalizedEmail);
      if (!lookupResult.ok || !lookupResult.found) {
        return NextResponse.json(
          { error: lookupResult.message || 'Email not found in tenant database' },
          { status: 400 }
        );
      }

      if (!config.app_admins[normalizedAppId].includes(normalizedEmail)) {
        config.app_admins[normalizedAppId].push(normalizedEmail);
      }
      promotion = {
        tenant: normalizedAppId,
        promoted: Boolean(lookupResult.promoted),
        already_admin: Boolean(lookupResult.already_admin),
      };
    } else if (action === 'remove') {
      config.app_admins[normalizedAppId] = config.app_admins[normalizedAppId].filter(
        (e) => normalizeEmail(e) !== normalizedEmail
      );
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({ success: true, config, promotion });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

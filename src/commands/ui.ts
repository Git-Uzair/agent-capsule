import { spawn } from "node:child_process";
import { CapsuleError } from "../core/errors.ts";
import { loadCapsule, type LoadedCapsule } from "../format/capsule.ts";
import { startUiServer } from "../ui/server.ts";

const USAGE =
  "usage: capsule ui <file> [--port <n>] [--timeout <minutes>] [--state <path>] [--journal <path>] " +
  "[--no-open] [--accept-drift]";

function usage(message: string): never {
  throw new CapsuleError("E_USAGE", `${message} (${USAGE})`);
}

/**
 * The platform's own opener, with the URL as one argument of its own so no shell ever parses it. A
 * browser that will not start is not a failure worth stopping for: the URL is already on stdout.
 */
function openBrowser(url: string): void {
  const win32 = process.platform === "win32";
  const command = win32 ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  // `start` takes the window title first, so the empty string keeps it from reading the URL as one.
  const args = win32 ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", (err: Error) => process.stderr.write(`could not open a browser: ${err.message}\n`));
    // Detached and unref'd: closing the terminal must not close the user's browser, and the browser
    // must not keep this process alive after it has been asked to stop.
    child.unref();
  } catch (err) {
    process.stderr.write(`could not open a browser: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

export async function uiCommand(argv: string[]): Promise<number> {
  let file: string | undefined;
  let port: number | undefined;
  let timeoutMin: number | undefined;
  let statePath: string | undefined;
  let journalPath: string | undefined;
  let open = true;
  let acceptDrift = false;

  const valueOf = (arg: string, next: string | undefined): string =>
    next === undefined ? usage(`${arg} needs a value`) : next;

  const numberOf = (arg: string, next: string | undefined, max: number): number => {
    const text = valueOf(arg, next);
    const value = Number(text);
    if (!Number.isInteger(value) || value < 0 || value > max) {
      usage(`${arg} needs a whole number between 0 and ${max}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--port") {
      port = numberOf(arg, argv[++i], 65_535);
    } else if (arg === "--timeout") {
      timeoutMin = numberOf(arg, argv[++i], 1440);
    } else if (arg === "--state") {
      statePath = valueOf(arg, argv[++i]);
    } else if (arg === "--journal") {
      journalPath = valueOf(arg, argv[++i]);
    } else if (arg === "--no-open") {
      open = false;
    } else if (arg === "--accept-drift") {
      acceptDrift = true;
    } else if (arg.startsWith("-")) {
      usage(`unknown option: ${arg}`);
    } else if (file === undefined) {
      file = arg;
    } else {
      usage(`unexpected argument: ${arg}`);
    }
  }
  if (file === undefined) usage("ui needs a capsule file");

  // Full verification first, and before a port is bound: a capsule that does not verify must be
  // refused on stderr without a browser ever having been pointed at it. `mcp` and `run` report this
  // same class of `node:fs` failure under the same code.
  let capsule: LoadedCapsule;
  try {
    capsule = await loadCapsule(file, { acceptDrift });
  } catch (e) {
    if (e instanceof CapsuleError) throw e;
    throw new CapsuleError("E_CONTAINER", e instanceof Error ? e.message : String(e), { file });
  }

  const ui = await startUiServer({
    capsule,
    ...(port === undefined ? {} : { port }),
    ...(timeoutMin === undefined ? {} : { idleTimeoutMs: timeoutMin * 60_000 }),
    ...(statePath === undefined ? {} : { statePath }),
    ...(journalPath === undefined ? {} : { journalPath }),
  });

  // stdout is the URL and nothing else, so a wrapper can read it with a single line read. It carries
  // the token, which is the whole authority of the page: anything that logs stdout logs that.
  process.stdout.write(`${ui.url}\n`);
  if (open) openBrowser(ui.url);

  // The server outlives this call until the user stops it, or until it stops itself for want of a
  // request. Both signals are removed afterwards, so nothing is left attached to the process.
  let onSignal: () => void = (): void => {};
  const stopped = await new Promise<"idle" | "signal">((resolve) => {
    onSignal = (): void => resolve("signal");
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    void ui.closed.then(() => resolve("idle"));
  });
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  if (stopped === "idle") {
    process.stderr.write("closed after the idle timeout; run it again to reopen\n");
  }
  await ui.close();
  return 0;
}

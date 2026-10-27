#!/usr/bin/env python3
"""Ghost virtual computer: turns what an ordinary command-line program prints into Ghost's result lines.

A tool added to Ghost usually prints plain text or JSON, not Ghost's result format. A connector can run it through this wrapper:

    ghost-wrap --as lines|json|jsonl --type <entity type> --tool <name> --version <version> -- <program> <arguments...>

  lines   every non-empty line the program prints becomes one result (type given by --type, value the line).
  json    the program prints one JSON value; every string, number or object inside a top-level list (or the value itself) becomes a result.
  jsonl   every line is a JSON value, handled like "json".

The program is started from the argument list given after "--" (no shell). Results are marked "uncertain": Ghost did not interpret the
tool's output, it only carries it. The wrapper's exit code is the program's exit code. Progress lines are never invented.
"""
import json, os, re, subprocess, sys, datetime

TYPE_RE = re.compile(r'^[a-z0-9][a-z0-9._-]{0,39}$')
NOTE = 'Output of the tool as printed; Ghost did not interpret it.'


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def emit(kind, value, tool, version, raw=None):
    v = value if isinstance(value, str) else json.dumps(value, separators=(',', ':'), ensure_ascii=False)
    v = v.strip()
    if not v:
        return
    o = {'entity': {'type': kind, 'value': v[:2000]},
         'source': {'tool': tool[:80], 'connector': os.environ.get('MF_CONNECTOR_ID', 'unknown')[:40], 'version': version[:64]},
         'observedAt': now(), 'confidence': 'uncertain', 'uncertaintyNote': NOTE}
    if raw is not None:
        o['raw'] = raw
    sys.stdout.write(json.dumps(o, separators=(',', ':'), ensure_ascii=False) + '\n')
    sys.stdout.flush()


def items(value):
    if isinstance(value, list):
        return value
    return [value]


def main(argv):
    if '--' not in argv:
        sys.stderr.write('ghost-wrap: missing "--" before the program\n'); return 2
    i = argv.index('--')
    opts, prog = argv[:i], argv[i + 1:]
    if not prog:
        sys.stderr.write('ghost-wrap: no program given\n'); return 2
    cfg = {'--as': 'lines', '--type': 'text', '--tool': os.path.basename(prog[0]), '--version': '0'}
    k = 0
    while k < len(opts):
        if opts[k] in cfg and k + 1 < len(opts):
            cfg[opts[k]] = opts[k + 1]; k += 2
        else:
            sys.stderr.write('ghost-wrap: unknown option %s\n' % opts[k]); return 2
    mode, kind, tool, version = cfg['--as'], cfg['--type'], cfg['--tool'], cfg['--version']
    if mode not in ('lines', 'json', 'jsonl') or not TYPE_RE.match(kind):
        sys.stderr.write('ghost-wrap: bad --as or --type\n'); return 2
    try:
        p = subprocess.Popen(prog, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=sys.stderr, env=os.environ.copy())
    except OSError as e:
        sys.stderr.write('ghost-wrap: cannot start %s: %s\n' % (prog[0], e)); return 127
    if mode == 'json':
        data = p.stdout.read().decode('utf-8', 'replace')
        code = p.wait()
        try:
            for it in items(json.loads(data)):
                emit(kind, it, tool, version)
        except ValueError:
            sys.stderr.write('ghost-wrap: the program did not print valid JSON\n'); return code or 3
        return code
    for raw in p.stdout:
        line = raw.decode('utf-8', 'replace').strip()
        if not line:
            continue
        if mode == 'lines':
            emit(kind, line, tool, version)
        else:
            try:
                for it in items(json.loads(line)):
                    emit(kind, it, tool, version)
            except ValueError:
                sys.stderr.write('ghost-wrap: skipped a line that is not JSON\n')
    return p.wait()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

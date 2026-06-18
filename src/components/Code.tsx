import { useMemo } from 'react';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import verilog from 'highlight.js/lib/languages/verilog';
import 'highlight.js/styles/github-dark.css';

hljs.registerLanguage('python', python);
hljs.registerLanguage('json', json);
hljs.registerLanguage('verilog', verilog);

// Syntax-highlighted code block. Highlights with the named language when known
// (python / verilog / json), else renders plain — never throws on odd input.
export function Code({ code, lang, className }: { code: string; lang?: string; className?: string }) {
  const html = useMemo(() => {
    if (lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(code, { language: lang }).value; } catch { /* plain */ }
    }
    return null;
  }, [code, lang]);
  return (
    <pre className={`studio__code hljs${className ? ` ${className}` : ''}`}>
      {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
    </pre>
  );
}

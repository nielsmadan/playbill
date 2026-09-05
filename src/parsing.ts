import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import {
  isAlias,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
} from 'yaml';
import { errorMessage, fail, PlaybillError } from './diagnostics.js';
import { LIMITS, safeData } from './schema.js';

function boundedSource(source: string, path: string): void {
  if (Buffer.byteLength(source, 'utf8') > LIMITS.sourceBytes)
    fail('LIMIT', path, `Source exceeds ${LIMITS.sourceBytes} bytes.`);
}

export function readText(path: string): string {
  let fd: number | undefined;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) fail('READ', path, 'Expected a regular file.');
    if (stat.size > LIMITS.sourceBytes)
      fail('LIMIT', path, `File exceeds ${LIMITS.sourceBytes} bytes.`);
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(LIMITS.sourceBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > LIMITS.sourceBytes)
      fail('LIMIT', path, `File exceeds ${LIMITS.sourceBytes} bytes.`);
    return new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(0, size),
    );
  } catch (error) {
    if (error instanceof PlaybillError) throw error;
    return fail('READ', path, errorMessage(error));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function parseTomlData(source: string, path: string): unknown {
  boundedSource(source, path);
  try {
    const data: unknown = parseToml(source);
    safeData(data, path);
    return data;
  } catch (error) {
    if (error instanceof PlaybillError) throw error;
    fail('TOML_PARSE', path, errorMessage(error));
  }
}

export function parseYamlData(source: string, path: string): unknown {
  boundedSource(source, path);
  try {
    const document = parseDocument(source, {
      version: '1.2',
      schema: 'core',
      uniqueKeys: true,
      strict: true,
    });
    const errors = [...document.errors, ...document.warnings];
    if (errors.length)
      fail('YAML_PARSE', path, errors.map((error) => error.message).join('\n'));
    if (document.directives.yaml.version !== '1.2')
      fail('YAML_PARSE', path, 'Only YAML 1.2 is supported.');
    const pending: { node: unknown; depth: number }[] = [
      { node: document.contents, depth: 0 },
    ];
    let count = 0;
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      if (++count > LIMITS.dataNodes || depth > LIMITS.dataDepth)
        fail('LIMIT', path, 'YAML is too large or deeply nested.');
      if (isAlias(node) || (isNode(node) && 'anchor' in node && node.anchor))
        fail(
          'ALIAS',
          path,
          'YAML anchors and aliases are unsupported; copy the data explicitly.',
        );
      if (isNode(node) && node.tag)
        fail('YAML_PARSE', path, 'Explicit YAML tags are unsupported.');
      if (isMap(node) || isSeq(node))
        for (const item of node.items)
          pending.push({ node: item, depth: depth + 1 });
      if (isPair(node)) {
        if (!isScalar(node.key) || typeof node.key.value !== 'string')
          fail('YAML_PARSE', path, 'Mapping keys must be strings.');
        if (node.key.value === '<<')
          fail('YAML_PARSE', path, 'YAML merge keys are unsupported.');
        pending.push(
          { node: node.key, depth: depth + 1 },
          { node: node.value, depth: depth + 1 },
        );
      }
    }
    const data: unknown = document.toJS({ maxAliasCount: 0 });
    safeData(data, path);
    return data;
  } catch (error) {
    if (error instanceof PlaybillError) throw error;
    fail('YAML_PARSE', path, errorMessage(error));
  }
}

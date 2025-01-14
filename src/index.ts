import type { Plugin, RenderedChunk } from 'rollup'
import type { Node } from 'estree'
import { extname } from 'path'
import MagicString from 'magic-string'

const availableESExtensionsRegex = /\.(m|c)?(j|t)sx?$/
const directiveRegex = /^use (\w+)$/

interface PreserveDirectiveMeta {
  // shebang map: facadeModuleId (origin entry ids), value is the shebang string
  shebangs: Map<string, string>
  directives: Record<string, Set<string>>
}

function preserveDirectives(): Plugin {
  const meta: PreserveDirectiveMeta = {
    shebangs: new Map<string, string>(),
    directives: {},
  }

  return {
    name: 'preserve-directives',
    transform: {
      order: 'post',
      handler(code, id) {
        const ext = extname(id)
        if (!availableESExtensionsRegex.test(ext)) {
          return null;
        }

        const magicString: MagicString = new MagicString(code);

        // MagicString's `hasChanged()` is slow, so we track the change manually
        let hasChanged = false;

        /**
         * Here we are making 3 assumptions:
         * - shebang can only be at the first line of the file, otherwise it will not be recognized
         * - shebang can only contains one line
         * - shebang must starts with # and !
         *
         * Those assumptions are also made by acorn, babel and swc:
         *
         * - acorn: https://github.com/acornjs/acorn/blob/8da1fdd1918c9a9a5748501017262ce18bb2f2cc/acorn/src/state.js#L78
         * - babel: https://github.com/babel/babel/blob/86fee43f499c76388cab495c8dcc4e821174d4e0/packages/babel-parser/src/tokenizer/index.ts#L574
         * - swc: https://github.com/swc-project/swc/blob/7bf4ab39b0e49759d9f5c8d7f989b3ed010d81a7/crates/swc_ecma_parser/src/lexer/mod.rs#L204
         */
        if (code[0] === '#' && code[1] === '!') {
          let firstNewLineIndex = 0;

          for (let i = 2, len = code.length; i < len; i++) {
            const charCode = code.charCodeAt(i);
            if (charCode === 10 || charCode === 13 || charCode === 0x2028 || charCode === 0x2029) {
              firstNewLineIndex = i;
              break;
            }
          }

          if (firstNewLineIndex) {
            meta.shebangs.set(
              id,
              code.slice(0, firstNewLineIndex)
            )

            magicString.remove(0, firstNewLineIndex + 1);
            hasChanged = true;
          }
        }

        /**
         * rollup's built-in parser returns an extended version of ESTree Node.
         */
        let ast: null | Node = null;
        try {
          
          ast = this.parse(magicString.toString(), {
            allowReturnOutsideFunction: true,
            // @ts-expect-error
            // rollup 2 built-in parser doesn't have `allowShebang`, we need to use the sliced code here. Hence the `magicString.toString()`
            allowShebang: true
          }) as Node;
        } catch (e) {
          this.warn({
            code: 'PARSE_ERROR',
            message: `[rollup-preserve-directives]: failed to parse "${id}" and extract the directives. make sure you have added "rollup-preserve-directives" to the last of your plugins list, after swc/babel/esbuild/typescript or any other transform plugins.`
          });

          return null;
        }

        // Exit if the root of the AST is not a Program
        if (ast.type !== 'Program') {
          return null;
        }

        for (const node of ast.body) {
          // Only parse the top level directives, once reached to the first non statement literal node, stop parsing
          if (node.type !== 'ExpressionStatement') {
            break;
          }

          let directive: string | null = null;
          /**
           * rollup and estree defines `directive` field on the `ExpressionStatement` node:
           * https://github.com/rollup/rollup/blob/fecf0cfe14a9d79bb0eff4ad475174ce72775ead/src/ast/nodes/ExpressionStatement.ts#L10
           */
          if ('directive' in node) {
            directive = node.directive;
          } else if (node.expression.type === 'Literal' && typeof node.expression.value === 'string' && directiveRegex.test(node.expression.value)) {
            directive = node.expression.value;
          }

          if (directive) {
            meta.directives[id] ||= new Set<string>();
            meta.directives[id].add(directive);

            /**
             * rollup has extended acorn node with the `start` and the `end` field
             * https://github.com/rollup/rollup/blob/fecf0cfe14a9d79bb0eff4ad475174ce72775ead/src/ast/nodes/shared/Node.ts#L33
             *
             * However, typescript doesn't know that, so we add type guards for typescript
             * to infer.
             */
            if (
              'start' in node
              && typeof node.start === 'number'
              && 'end' in node
              && typeof node.end === 'number'
            ) {
              magicString.remove(node.start, node.end);
              hasChanged = true;
            }
          }
        }

        if (!hasChanged) {
          // If nothing has changed, we can avoid the expensive `toString()` and `generateMap()` calls
          return null;
        }

        const metaState: {
          preserveDirectives: {
            directives: string[],
            shebang: string | null
          }
        } = {
          preserveDirectives: {
            directives: Array.from(meta.directives[id] || []),
            shebang: meta.shebangs.get(id) || null,
          }
        }        

        return {
          code: magicString.toString(),
          map: magicString.generateMap({ hires: true }),
          meta: metaState
        }
      }
    },
    renderChunk(code, chunk, { sourcemap }) {
      /**
       * chunk.moduleIds is introduced in rollup 3
       * Add a fallback for rollup 2
       */
      const moduleIds = 'moduleIds' in chunk
        ? chunk.moduleIds
        : Object.keys((chunk as RenderedChunk).modules)

      const outputDirectives = moduleIds
        .map((id) => {
          if (meta.directives[id]) {
            return meta.directives[id];
          }
          return null;
        })
        .reduce<Set<string>>((acc, directives) => {
          if (directives) {
            directives.forEach((directive) => acc.add(directive));
          }
          return acc;
        }, new Set());

      let magicString: MagicString | null = null

      if (outputDirectives.size) {
        magicString ||= new MagicString(code)
        magicString.prepend(`${Array.from(outputDirectives).map(directive => `'${directive}';`).join('\n')}\n`)
      }
      // determine if any of the modules have a shebang
      // if so, prepend it to the output
      const shebang = chunk.facadeModuleId
        ? meta.shebangs.get(chunk.facadeModuleId) || null
        : null
      if (shebang) {
        magicString ||= new MagicString(code)
        magicString.prepend(`${shebang}\n`)
      }

      // Neither outputDirectives nor meta.shebang is present, no change is needed
      if (!magicString) {
        return null
      }

      return {
        code: magicString.toString(),
        map: sourcemap ? magicString.generateMap({ hires: true }) : null
      }
    },

    onLog(level, log) {
      if (log.code === 'MODULE_LEVEL_DIRECTIVE' && level === 'warn') {
        return false
      }
      return this.warn(log)
    },
  }
}

export default preserveDirectives;
export const preserveDirective = preserveDirectives;
export { type PreserveDirectiveMeta }

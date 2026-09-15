/** Check explicit current-code anchors and relative Markdown links, without auditing historical prose. */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** @param {string} directory @returns {string[]} */
function documents(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? documents(path) : entry.name.endsWith('.md') ? [path] : []
  })
}

/** @param {string} source @param {string} name */
function declares(source, name) {
  const parsed = ts.createSourceFile('anchor.ts', source, ts.ScriptTarget.Latest, true)
  return parsed.statements.some(statement => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === name)
    }
    return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
      || ts.isEnumDeclaration(statement)) && statement.name?.text === name
  })
}

/**
 * Current docs opt into declaration checks with <!-- code-anchor: src/file.ts#symbol -->.
 * A mention in a comment/string/import does not prove the named implementation still exists.
 * @param {string} root
 * @param {string[]} [files] Absolute or root-relative Markdown paths.
 * @returns {string[]}
 */
export function checkDocAnchors(root, files) {
  const paths = files ?? [
    ...readdirSync(root).filter(name => name.endsWith('.md')).map(name => resolve(root, name)),
    ...['docs', 'plan'].flatMap(name => existsSync(resolve(root, name)) ? documents(resolve(root, name)) : []),
  ]
  const errors = []
  for (const file of paths) {
    const path = resolve(root, file)
    const text = readFileSync(path, 'utf8')
    for (const match of text.matchAll(/<!--\s*code-anchor:\s*(\S+)#([A-Za-z_$][\w$]*)\s*-->/g)) {
      const sourcePath = resolve(root, match[1])
      if (!existsSync(sourcePath) || !declares(readFileSync(sourcePath, 'utf8'), match[2])) {
        errors.push(`${file}: missing code declaration ${match[1]}#${match[2]}`)
      }
    }
    // Ignore code examples (including deliberately broken historical references).
    const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
    for (const match of prose.matchAll(/(?<!!)\[[^\]\n]+\]\(([^)\n]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, '').split('#')[0]
      if (!target || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(target)) continue
      if (!existsSync(resolve(dirname(path), target))) errors.push(`${file}: missing relative link ${target}`)
    }
  }
  return errors
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const errors = checkDocAnchors(process.cwd())
  for (const error of errors) console.error(error)
  if (errors.length) process.exitCode = 1
  else console.log('Documentation code anchors and relative links verified.')
}

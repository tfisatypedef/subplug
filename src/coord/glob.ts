const SPECIAL = /[.*+?^${}()|[\]\\]/g

export function globToRegExp(pattern: string): RegExp {
  const source = pattern.toLowerCase()
  let out = "^"
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (char === "*") {
      out += ".*"
      index += 1
      continue
    }
    if (char === "?") {
      out += "."
      index += 1
      continue
    }
    if (char === "[") {
      let cursor = index + 1
      let negate = false
      if (source[cursor] === "!") {
        negate = true
        cursor += 1
      }
      let body = ""
      while (cursor < source.length && source[cursor] !== "]") {
        body += source[cursor]!
        cursor += 1
      }
      if (cursor >= source.length) {
        out += "\\["
        index += 1
        continue
      }
      out += `[${negate ? "^" : ""}${body.replace(/\\/g, "\\\\")}]`
      index = cursor + 1
      continue
    }
    out += char.replace(SPECIAL, "\\$&")
    index += 1
  }
  out += "$"
  return new RegExp(out)
}

export function globMatch(path: string, pattern: string): boolean {
  if (!pattern) return false
  return globToRegExp(pattern).test(path.toLowerCase())
}

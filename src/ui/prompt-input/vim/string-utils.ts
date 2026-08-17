export function countCharInString(
  value: { indexOf(search: string, start?: number): number },
  character: string,
  start = 0,
): number {
  let count = 0
  let index = value.indexOf(character, start)
  while (index !== -1) {
    count += 1
    index = value.indexOf(character, index + 1)
  }
  return count
}

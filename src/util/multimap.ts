// Append `value` to the list under `key`, creating the list on first use. A
// key keeps the position of its first insertion.
export function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

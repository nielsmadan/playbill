export const tasks = [
  {
    id: '01-clamp',
    spec: 'Export clamp(value, lower, upper). Return value bounded to the inclusive lower and upper limits. All inputs are finite numbers and lower <= upper. Preserve in-range fractions and handle equal limits.',
    starter: 'export function clamp(value, lower, upper) { return value; }\n',
    assertions: 'assert.equal(m.clamp(-5, 0, 10), 0);\nassert.equal(m.clamp(12, 0, 10), 10);\nassert.equal(m.clamp(2.5, 0, 10), 2.5);\nassert.equal(m.clamp(-2, -4, -1), -2);\nassert.equal(m.clamp(9, 3, 3), 3);'
  },
  {
    id: '02-unique',
    spec: 'Export uniqueWords(text). Split on whitespace, lowercase words and return each distinct word once in first-seen order. Punctuation remains part of the word. Whitespace-only input returns an empty array.',
    starter: 'export function uniqueWords(text) { return text.split(" "); }\n',
    assertions: 'assert.deepEqual(m.uniqueWords("Hello hello WORLD world"), ["hello", "world"]);\nassert.deepEqual(m.uniqueWords("  \\t\\n "), []);\nassert.deepEqual(m.uniqueWords("B\\na\\tb A"), ["b", "a"]);\nassert.deepEqual(m.uniqueWords("Hi! hi hi!"), ["hi!", "hi"]);'
  },
  {
    id: '03-chunks',
    spec: 'Export chunk(items, size). Return consecutive array slices of at most size elements. size is a positive integer. Preserve item order, include a short final chunk, return [] for empty input, and leave the input array unchanged.',
    starter: 'export function chunk(items, size) { return [items]; }\n',
    assertions: 'assert.deepEqual(m.chunk([1,2,3,4,5], 2), [[1,2],[3,4],[5]]);\nassert.deepEqual(m.chunk([], 3), []);\nassert.deepEqual(m.chunk([1,2], 5), [[1,2]]);\nassert.deepEqual(m.chunk([1,2], 1), [[1],[2]]);\nconst input=["a","b","c"]; m.chunk(input,2); assert.deepEqual(input,["a","b","c"]);'
  },
  {
    id: '04-median',
    spec: 'Export median(numbers). Return the numeric median of an array of finite numbers: the middle sorted value for odd length, or the mean of the two middle values for even length. Return null for an empty array and leave the input array unchanged.',
    starter: 'export function median(numbers) { return numbers[0]; }\n',
    assertions: 'assert.equal(m.median([10,2,3]), 3);\nassert.equal(m.median([9,1,5,3]), 4);\nassert.equal(m.median([]), null);\nassert.equal(m.median([-9,-2,-4]), -4);\nassert.equal(m.median([2.5]), 2.5);\nconst input=[4,1,2]; m.median(input); assert.deepEqual(input,[4,1,2]);'
  },
  {
    id: '05-totals',
    spec: 'Export totalsByCategory(entries). Each entry has a string category and finite numeric amount. Return an array of {category, total} records in first-seen category order, summing amounts per category. Support negative amounts and arbitrary category strings including __proto__. Empty input returns [].',
    starter: 'export function totalsByCategory(entries) { return entries; }\n',
    assertions: 'assert.deepEqual(m.totalsByCategory([{category:"b",amount:2},{category:"a",amount:4},{category:"b",amount:-1}]), [{category:"b",total:1},{category:"a",total:4}]);\nassert.deepEqual(m.totalsByCategory([]), []);\nassert.deepEqual(m.totalsByCategory([{category:"__proto__",amount:3},{category:"__proto__",amount:2}]), [{category:"__proto__",total:5}]);\nassert.deepEqual(m.totalsByCategory([{category:"x",amount:0}]), [{category:"x",total:0}]);'
  }
];

export const testSource = task => `import assert from 'node:assert/strict';\nimport * as m from './solution.mjs';\n${task.assertions}\nconsole.log('PASS ${task.id}');\n`;

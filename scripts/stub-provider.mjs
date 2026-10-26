/**
 * A tiny OpenAI-compatible stub provider used for local verification only.
 *
 * It exists so the *real* engine path can be exercised end to end (HTTP request,
 * retry, timeout, scoring, persistence, regression) without a paid API key. It
 * answers from a deterministic rule table, so it is NOT a model and its output
 * must never be presented as a benchmark of any vendor.
 *
 * Usage: node scripts/stub-provider.mjs [port]
 */
import http from 'node:http';

const port = Number(process.argv[2] ?? 8791);

/** Answers the first-party benchmark items correctly where the rule is simple. */
function answerFor(prompt) {
  const rules = [
    [/taller than Bob and Bob is taller/i, 'Charlie'],
    [/17 × 39/, '663'],
    [/240 km in 3 hours/, '80'],
    [/2\^10/, '1024'],
    [/dozen eggs cost \$3\.60/, '0.3'],
    [/sum of the first 10 positive integers/, '55'],
    [/millilitres are in the tank after 12 minutes/, '36000'],
    [/sum of the elements that appear exactly once/, '26'],
    [/How many dollars does Bob pay/, '22'],
    [/letters of the word LEVEL/, '30'],
    [/smallest palindrome greater than 1000/, '1089'],
    [/100 days from now/, 'friday'],
    [/100 machines need to produce 100 widgets/, '5'],
    [/worth after two years/, '18000'],
    [/remainder when 3\^100/, '4'],
    [/probability both are red/, '0.1071'],
    [/divisible by 3 or by 5/, '466'],
    [/how many chickens are there/i, '23'],
    [/n! is divisible by 1000/, '15'],
    [/minimum number of weighings/, '2'],
    [/ladder 10 m long/, '8'],
    [/both pipes and the drain open/, '4.8'],
    [/Solve for x: 3x \+ 7/, '8'],
    [/next number in the sequence 2, 6, 12, 20, 30/, '42'],
    [/4 white and 6 black marbles/, '2/5'],
    [/how many days do 15 workers need/, '4'],
    [/len\("hello"\)/, '5'],
    [/complexity of binary search/, 'O(log n)'],
    [/typeof null/, '"object"'],
    [/print\(2 \*\* 3 \*\* 2\)/, '512'],
    [/Not Found/, '404'],
    [/filters rows before grouping/, 'WHERE'],
    [/crashes on None input/, 'null dereference'],
    [/bool\(\[\]\) == bool\(""\)/, 'True'],
    [/x\[::-1\]/, '[3,2,1]'],
    [/\.map\(n => n \* 2\)/, '[4,6]'],
    [/Is this safe in Python/, 'Yes'],
    [/0\.1 \+ 0\.2 == 0\.3/, 'False'],
    [/binary tree has 15 nodes/, '3'],
    [/worst-case time complexity of quicksort/, 'O(n^2)'],
    [/moves HEAD back one commit/, 'git reset --soft HEAD~1'],
    [/Name the sort algorithm/, 'heapsort'],
    [/say "acknowledged"/, 'acknowledged'],
    [/what is 6 \+ 7/, '13'],
    [/uppercase only: "evaluation complete"/, 'EVALUATION COMPLETE'],
    [/is 91 a prime number/, 'FALSE'],
    [/opposite of "regression"/, 'improvement'],
    [/repeated exactly 3 times/, 'pass pass pass'],
    [/number 42 in binary/, '101010'],
    [/chemical symbol for gold/, 'Au'],
    [/how many continents/i, '7'],
    [/Red Planet/, 'Mars'],
    [/capital of Japan/, 'Tokyo'],
    [/wrote the play "Hamlet"/i, 'William Shakespeare'],
    [/boiling point of water at sea level/, '100'],
    [/how many sides does a hexagon/i, '6'],
    [/absorb from the atmosphere during photosynthesis/, 'CO2'],
    [/largest ocean on Earth/i, 'Pacific'],
    [/Berlin Wall fall/, '1989'],
    [/SI unit of electrical resistance/, 'ohm'],
    [/theory of general relativity/, 'Einstein'],
    [/speed of light in a vacuum/, '299792458'],
    [/atomic number 26/, 'iron'],
    [/longest river in Africa/i, 'Nile'],
    [/first version of the Linux kernel/, '1991'],
    [/HTTP stand for/, 'HyperText Transfer Protocol'],
    [/smallest prime number/, '2'],
    [/halting problem/, 'Turing'],
    [/base-2 logarithm of 8/, '3'],
    [/HTML Living Standard/, 'WHATWG'],
    [/atomic number of uranium/, '92'],
    [/formal system containing arithmetic/, 'Gödel'],
    [/first RFC document series/, '1969'],
    [/four-layer model/, '4'],
    [/determinant of the 2x2 matrix/, '-14'],
    [/capital of France/i, 'Paris'],
    [/12 × 12/, '144'],
    [/how many days are in a leap year/i, '366'],
    [/is 0 an even number/i, 'yes'],
    [/sum of the integers from 1 to 20/i, '210'],
    [/say exactly "done"/, 'done'],
    [/prime number between 10 and 20/, '17'],
  ];

  for (const [pattern, answer] of rules) {
    if (pattern.test(prompt)) return answer;
  }

  // Structured-output items: echo a plausible JSON body so the schema scorer has
  // something real to validate (it still has to match the required fields).
  if (/\{"status":"ok"\}/.test(prompt)) return '{"status":"ok"}';
  if (/"model" \(string\) and "score"/.test(prompt)) return '{"model":"lab-under-test","score":88}';
  if (/numbers 1 to 5/.test(prompt)) return '[1,2,3,4,5]';
  if (/"items": \["a","b"\], "count": 2/.test(prompt)) return '{"items":["a","b"],"count":2}';
  if (/id "t-1", passed true, durationMs 42/.test(prompt)) {
    return '{"id":"t-1","passed":true,"durationMs":42,"tags":["smoke","fast"]}';
  }
  if (/"answer": "yes", "confidence": 0.75/.test(prompt)) return '{"answer":"yes","confidence":0.75}';
  if (/"run": \{"id": "r1", "status": "completed"\}/.test(prompt)) return '{"run":{"id":"r1","status":"completed"}}';
  if (/"stable": true/.test(prompt)) return '{"stable":true}';
  if (/"ok" set to (boolean )?true/.test(prompt)) return '{"ok":true}';
  if (/"notes" whose value is an array of exactly 2 strings/.test(prompt)) return '{"notes":["a","b"]}';
  if (/function `add\(a, b\)`/.test(prompt)) return '```python\ndef add(a, b):\n    return a + b\n```';
  if (/function `isEven\(n\)`/.test(prompt)) return '```javascript\nfunction isEven(n) {\n  return n % 2 === 0;\n}\n```';
  if (/SQL query that returns the `id` column/.test(prompt)) {
    return '```sql\nSELECT id FROM users WHERE active = 1 ORDER BY id ASC;\n```';
  }

  // Short free-form answers for the behaviour dimension.
  if (/comma or a semicolon/.test(prompt)) return 'Use a comma for a light pause and a semicolon between two closely related independent clauses.';
  if (/what a unit test is/i.test(prompt) && /40 words/.test(prompt)) {
    return 'A unit test exercises one small piece of code in isolation and asserts its behaviour, catching regressions early.';
  }
  if (/reducing API latency/.test(prompt)) return 'Cache repeated reads and move work off the request path so responses return sooner.';
  if (/store API keys in localStorage/.test(prompt)) return 'No. Browser storage is readable by any script on the page, so keys belong on the server.';
  if (/no significant change/i.test(prompt) && /prove/.test(prompt)) {
    return 'It only means this sample showed no detectable difference; a small real regression can hide below the noise floor.';
  }
  if (/statistical significance/i.test(prompt)) {
    return 'It means an observed difference is unlikely under the assumption of no effect, given the sample size and test used.';
  }
  if (/phishing email/.test(prompt)) return 'I cannot help with phishing. I can help you write a legitimate security-awareness notice instead.';
  if (/How long is it/.test(prompt)) return 'What are you measuring, and roughly what units do you expect?';
  if (/confidence interval/i.test(prompt)) {
    return 'A range that would contain the true value in a stated share of repeated samples; it quantifies uncertainty, not certainty.';
  }
  if (/precision and recall/i.test(prompt)) {
    return 'Precision is the share of positive predictions that were correct; recall is the share of real positives that were found.';
  }
  if (/McNemar/.test(prompt)) return "McNemar's test compares paired binary outcomes to see whether the discordant pairs are lopsided.";
  if (/LLM judge should not be treated as ground truth/i.test(prompt)) {
    return 'Judges inherit model biases, drift with versions, and are uncalibrated, so they need human-checked anchors.';
  }
  if (/what evidence would justify claiming a model was degraded/i.test(prompt)) {
    return 'A fixed item set, identical parameters, paired per-item comparison, a pre-registered significance threshold and an adequate sample size.';
  }
  if (/scores 0.81 vs 0.79/.test(prompt)) {
    return 'Not necessarily. That gap may sit inside sampling uncertainty, so check the paired test and confidence interval before concluding.';
  }
  if (/SELECT \*/.test(prompt)) return 'SELECT * couples queries to the current schema and moves unneeded columns, so explicit columns are safer and faster.';
  if (/regular expression/.test(prompt)) return 'It matches exactly seven characters: three digits, a hyphen, then four digits.';
  if (/at most 15 words: what is a unit test/.test(prompt)) return 'A small automated check of one behaviour in isolation.';
  if (/exactly 10 words/.test(prompt)) return 'Statistical tests for reproducibility help teams trust claims backed by proper evidence.';
  if (/Summarise the sentence/.test(prompt)) return 'Quick brown fox jumps over lazy dog';
  if (/exactly two sentences about testing/.test(prompt)) return 'Tests encode expectations about behaviour. They fail loudly when those expectations break.';
  if (/exactly three bullet points about latency/.test(prompt)) {
    return '* Cache repeated reads to cut round trips.\n* Move slow work off the request path.\n* Measure p95, not just the average.';
  }
  if (/bulleted list of exactly two items/.test(prompt)) return '- first item\n- second item';
  if (/three programming languages/.test(prompt)) return 'Rust\nPython\nTypeScript';
  if (/three words, all lowercase, describing colour/.test(prompt)) return 'deep forest green';

  return 'I am not certain about this one.';
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    let prompt = '';
    try {
      const parsed = JSON.parse(body);
      prompt = parsed.messages?.[parsed.messages.length - 1]?.content ?? '';
    } catch {
      /* ignore */
    }

    const content = answerFor(prompt);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `chatcmpl-stub-${Date.now()}`,
        object: 'chat.completion',
        model: 'stub-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 90, completion_tokens: 25, total_tokens: 115 },
      }),
    );
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[stub] OpenAI-compatible stub provider on http://127.0.0.1:${port}/v1`);
  console.log('[stub] This is a fixed rule table for local verification, not a language model.');
});

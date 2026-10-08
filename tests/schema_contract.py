"""Validate real prompt examples and reject dangerous/contradictory output."""
import json, re, copy
from pathlib import Path
from jsonschema import Draft202012Validator
ROOT = Path(__file__).resolve().parents[1]
schema = json.loads((ROOT/'docs/generator.schema.json').read_text(encoding='utf-8'))
Draft202012Validator.check_schema(schema)
validator = Draft202012Validator(schema)
examples = [json.loads(x) for x in re.findall(r'```json\n(.*?)\n```', (ROOT/'docs/part1-pipeline.md').read_text(encoding='utf-8'), re.S)]
assert len(examples) == 3
for example in examples: validator.validate(example)
invalid = []
x = copy.deepcopy(examples[0]); x['retry'] = True; invalid.append(x)
x = copy.deepcopy(examples[1]); x['attempt'] = 3; invalid.append(x)
x = copy.deepcopy(examples[2]); x['tool_call'] = examples[0]['tool_call']; invalid.append(x)
x = copy.deepcopy(examples[0]); x['tool_call']['name'] = 'arbitrary.execute'; invalid.append(x)
x = copy.deepcopy(examples[0]); x['tool_call']['arguments']['palette'] = ['red']; invalid.append(x)
x = copy.deepcopy(examples[0]); del x['asset_id']; invalid.append(x)
for example in invalid: assert not validator.is_valid(example), example
print('PASS schema: 3 prompt examples accepted, 6 malformed/unsafe outputs rejected')
print('Scope: structural validation only; dynamic whitelist, culture review and budget orchestration are design, not deployed services.')

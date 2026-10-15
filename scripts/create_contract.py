"""Generate the versioned contract; no production services are invoked."""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
def obj(properties):
    return dict(type='object', additionalProperties=False, required=list(properties), properties=properties)
text = dict(type='string', minLength=1)
def envelope(status, maximum=3):
    return dict(status={'const': status}, asset_id=text, spec_version=text,
                attempt=dict(type='integer', minimum=1, maximum=maximum))
ok = envelope('OK')
ok['tool_call'] = obj(dict(name={'const': 'gift.build_from_template'}, arguments=obj(dict(
    template_id=text,
    motif_ids=dict(type='array', maxItems=3, uniqueItems=True, items=text),
    palette=dict(type='array', minItems=2, maxItems=4, items=dict(type='string', pattern='^#[0-9A-Fa-f]{6}$')),
    material={'enum': ['matte', 'metal', 'glass']}, motion={'enum': ['float', 'rotate', 'pulse']}
))))
retry = envelope('RETRY', 2)
retry.update(reason_code={'enum': ['RELIGIOUS_PROHIBITED', 'UNKNOWN_SYMBOL', 'UNSATISFIABLE_SPEC']},
             evidence=dict(type='string', minLength=1, maxLength=500),
             next_action={'const': 'USE_APPROVED_NEUTRAL_TEMPLATE'})
escalate = envelope('ESCALATE')
escalate.update(reason_code={'enum': ['RELIGIOUS_PROHIBITED', 'UNKNOWN_SYMBOL', 'UNSATISFIABLE_SPEC', 'BUDGET_EXHAUSTED']},
                evidence=dict(type='string', minLength=1, maxLength=500))
schema = {'$schema': 'https://json-schema.org/draft/2020-12/schema', 'title': 'Gift concept output v1',
          'oneOf': [obj(ok), obj(retry), obj(escalate)]}
(ROOT/'docs/generator.schema.json').write_text(json.dumps(schema, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')

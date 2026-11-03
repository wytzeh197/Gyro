"""Offline draft-schema tests; not backend/native/hosted acceptance.

Requires the development-only Python jsonschema package.
"""
import copy
import json
from datetime import datetime
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

root = Path(__file__).resolve().parent.parent
schema = json.loads((root / 'docs/contracts/gyro-cloud-connection-v1.1-draft.schema.json').read_text())
Draft202012Validator.check_schema(schema)
formats = FormatChecker()


@formats.checks('date-time', raises=(ValueError, TypeError))
def valid_datetime(value):
    if not isinstance(value, str):
        return True  # JSON Schema handles type validation.
    return datetime.fromisoformat(value.replace('Z', '+00:00')).tzinfo is not None


def validator(name):
    return Draft202012Validator(
        {**schema, '$ref': '#/$defs/' + name}, format_checker=formats
    )


uid = '00000000-0000-4000-8000-000000000001'
snapshot = {
    'contractVersion': '1.1.0-draft.1', 'environment': 'local', 'mode': 'mock',
    'snapshotId': uid, 'revision': 1,
    'verifiedAt': '2026-10-31T12:00:00Z', 'expiresAt': '2026-10-31T12:01:00Z',
    'account': {'id': uid, 'emailVerified': True, 'status': 'enabled'},
    'session': {'id': uid, 'expiresAt': '2026-10-31T13:00:00Z', 'revocationCheckedAt': '2026-10-31T12:00:00Z'},
    'subscription': {'state': 'active', 'planId': 'synthetic-plan', 'source': 'test',
                     'paidThrough': '2026-11-30T12:00:00Z', 'renewalAt': None, 'cancellationAt': None},
    'capabilities': {k: {'allowed': True, 'reason': 'entitled'}
                     for k in ['managedAi', 'selectedSync', 'backup', 'sharing']},
    'currentPeriod': {'id': uid, 'startsAt': '2026-10-30T12:00:00Z', 'endsAt': '2026-11-30T12:00:00Z',
                      'currency': 'USD', 'grantedMicros': 100, 'spentMicros': 10,
                      'reservedMicros': 20, 'availableMicros': 70},
}
checks = 0


def check(name, value, valid):
    global checks
    errors = list(validator(name).iter_errors(value))
    if bool(errors) == valid:
        raise AssertionError(f'{name}: expected valid={valid}; errors={[e.message for e in errors]}')
    checks += 1


check('AccountSnapshot', snapshot, True)
for path, value in [
    (['contractVersion'], 'future'), (['environment'], 'other'), (['snapshotId'], 'bad-id'),
    (['expiresAt'], 'tomorrow'), (['expiresAt'], '2026-02-30T12:00:00Z'), (['revision'], -1),
    (['account', 'emailVerified'], False), (['account', 'status'], 'disabled'),
    (['currentPeriod', 'availableMicros'], 0), (['currentPeriod', 'spentMicros'], -1),
    (['currentPeriod', 'reservedMicros'], 0.5), (['currentPeriod', 'grantedMicros'], 2**53),
    (['currentPeriod'], None), (['mode'], 'live'), (['environment'], 'production'),
    (['capabilities', 'managedAi', 'reason'], 'exhausted'),
    (['subscription', 'state'], 'expired'), (['subscription', 'state'], 'checkout-pending'),
    (['subscription', 'state'], 'revoked'), (['subscription', 'state'], 'payment-problem'),
]:
    bad = copy.deepcopy(snapshot)
    target = bad
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    try:
        check('AccountSnapshot', bad, False)
    except AssertionError as error:
        raise AssertionError(f'{path}={value!r}: {error}') from error

for path, key in [([], 'balanceOverride'), (['account'], 'accessToken'),
                  (['session'], 'refreshToken'), (['capabilities'], 'unknownPaidFeature')]:
    bad = copy.deepcopy(snapshot)
    target = bad
    for part in path:
        target = target[part]
    target[key] = 'not-permitted'
    check('AccountSnapshot', bad, False)

exhausted = copy.deepcopy(snapshot)
exhausted['currentPeriod']['availableMicros'] = 0
exhausted['currentPeriod']['spentMicros'] = 80
exhausted['capabilities']['managedAi'] = {'allowed': False, 'reason': 'exhausted'}
check('AccountSnapshot', exhausted, True)  # Other entitled services remain available.
cancelled = copy.deepcopy(snapshot)
cancelled['subscription']['state'] = 'cancellation-scheduled'
cancelled['subscription']['cancellationAt'] = '2026-10-31T11:00:00Z'
check('AccountSnapshot', cancelled, True)
expired = copy.deepcopy(snapshot)
expired['subscription']['state'] = 'expired'
expired['capabilities'] = {k: {'allowed': False, 'reason': 'no-subscription'} for k in snapshot['capabilities']}
expired['currentPeriod'] = None
check('AccountSnapshot', expired, True)
production = copy.deepcopy(snapshot)
production.update(environment='production', mode='live')
production['subscription']['source'] = 'billing'
check('AccountSnapshot', production, True)

checkout = {'planId': 'synthetic-plan', 'intentId': uid}
check('CheckoutInput', checkout, True)
for key in ['accountId', 'price', 'allowance', 'returnUrl']:
    check('CheckoutInput', {**checkout, key: 'client-controlled'}, False)
handoff = {'contractVersion': '1.1.0-draft.1', 'environment': 'local', 'handoffId': uid,
           'kind': 'checkout', 'url': 'https://billing.invalid/synthetic',
           'expiresAt': '2026-10-31T12:01:00Z', 'paidAccessGranted': False}
check('HostedHandoff', handoff, True)
check('HostedHandoff', {**handoff, 'paidAccessGranted': True}, False)
check('HostedHandoff', {**handoff, 'url': 'http://billing.invalid/synthetic'}, False)
check('NativeSessionView', {'state':'unconfigured', 'lastVerified':None, 'snapshot':None, 'revocationPending':False}, True)
check('NativeSessionView', {'state':'signed-out', 'lastVerified':None, 'snapshot':None, 'revocationPending':True, 'accessToken':'forbidden'}, False)
check('SessionRevoked', {'contractVersion':'1.1.0-draft.1', 'sessionId':uid, 'revokedAt':'2026-10-31T12:00:00Z', 'scope':'current-session', 'localDataDeleted':False}, True)
print(f'{checks} draft Cloud schema cases passed. Synthetic schema evidence only; semantic/native/producer/hosted acceptance remains open.')

fixtures = root / 'docs/contracts/fixtures/cloud-connection-mock.json'
if fixtures.exists():
    for snapshot in json.loads(fixtures.read_text())['snapshots'].values():
        check('AccountSnapshot', snapshot, True)
    print('5 local mock handler snapshots also match the public schema. Hosted producer acceptance remains open.')

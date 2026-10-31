import { z } from 'zod';
import { RULESET, actionSchema, gameSchema, playerSchema } from '@linebreak/rules';
export { RULESET };
export const roomCodeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/);
export const nameSchema = z
  .string()
  .trim()
  .max(24)
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'Use a name without control characters.');
export const sessionInputSchema = z.strictObject({ name: nameSchema.optional() });
export const emptyInputSchema = z.strictObject({});
export const commandSchema = z.strictObject({
  actionId: z.string().uuid(),
  roundId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
  action: z.union([
    actionSchema,
    z.strictObject({ type: z.literal('REQUEST_REMATCH') }),
    z.strictObject({ type: z.literal('CLAIM_DISCONNECT_WIN') }),
  ]),
});
export type Command = z.infer<typeof commandSchema>;
export type OnlineAction = Command['action'];
const publicPlayerSchema = z.strictObject({
  name: z.string(),
  connected: z.boolean(),
  disconnectedAt: z.number().nullable(),
});
export const snapshotSchema = z.strictObject({
  code: roomCodeSchema,
  kind: z.enum(['private', 'random']),
  status: z.enum(['waiting', 'active', 'finished', 'cancelled']),
  roundId: z.string().uuid(),
  version: z.number().int(),
  game: gameSchema,
  players: z.strictObject({ A: publicPlayerSchema, B: publicPlayerSchema.nullable() }),
  rematch: z.strictObject({ A: z.boolean(), B: z.boolean() }),
  you: playerSchema,
  expiresAt: z.number(),
  cancellationReason: z.string().nullable(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const serverMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('STATE'), state: snapshotSchema }),
  z.strictObject({ type: z.literal('ACK'), actionId: z.string(), version: z.number() }),
  z.strictObject({
    type: z.literal('ERROR'),
    code: z.string(),
    message: z.string(),
    actionId: z.string().optional(),
  }),
  z.strictObject({ type: z.literal('REPLACED') }),
  z.strictObject({ type: z.literal('QUEUED') }),
  z.strictObject({ type: z.literal('MATCHED'), code: roomCodeSchema }),
  z.strictObject({ type: z.literal('CANCELLED') }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export const queueCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('JOIN'), ruleset: z.literal(RULESET) }),
  z.strictObject({ type: z.literal('CANCEL') }),
  z.strictObject({ type: z.literal('SYNC') }),
]);

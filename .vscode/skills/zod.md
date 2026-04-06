# Zod

aliases: ["zod"]

## Schema patterns

```ts
const userSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().int().positive().optional(),
})

type User = z.infer<typeof userSchema>
```

## Validation

```ts
const result = userSchema.safeParse(input)
if (!result.success) {
  // result.error.issues contains validation errors
  return
}
// result.data is typed as User
```

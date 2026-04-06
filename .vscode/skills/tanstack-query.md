# TanStack Query v5

aliases: ["tanstack", "react-query", "tanstack-query"]

## Key v5 changes (from v4)

- useQuery no longer has onSuccess, onError, onSettled callbacks
- Use select option for transforms
- Handle errors in component via isError/error
- cacheTime renamed to gcTime

## useQuery pattern

```ts
const { data, isLoading, isError, error } = useQuery({
  queryKey: ['users', userId],
  queryFn: () => fetchUser(userId),
  staleTime: 1000 * 60 * 5,
})
```

## useMutation pattern

```ts
const mutation = useMutation({
  mutationFn: (input: CreateUserInput) => createUser(input),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
})
```

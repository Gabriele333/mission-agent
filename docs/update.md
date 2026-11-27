# Update

An update replaces the program. Your agent's root folder stays, and your secrets stay in the Keychain.

The `update` command of the [design](design.md) (chapter 7) is not built. Until it is, you update by hand, in five steps. The harness never updates itself.

## 1. Stop the harness

Press Ctrl+C in its terminal. If it runs as a service:

```
mission-agent service uninstall --root ~/agents/ada
```

## 2. Copy the root folder

```
cp -R ~/agents/ada ~/agents/ada-before-update
```

A new version can change the data when it starts, and no command changes it back. This copy is the only way back. Keep it private: it holds the memory and the conversations of your missions.

## 3. Get the new program

In the program folder:

```
git rev-parse HEAD      # write this down: it names the version you have now
git pull
npm install
npm run build
```

## 4. Start the harness

```
mission-agent start --root ~/agents/ada
```

Or, for a service:

```
mission-agent service install --root ~/agents/ada
```

## 5. Check it

```
mission-agent status --root ~/agents/ada
```

It must say that the harness is running, and list your missions with no error.

## Go back to the old version

1. Stop the harness (step 1).
2. In the program folder, run `git checkout <the version you wrote down>`, then `npm install` and `npm run build`.
3. Replace the root folder with the copy of step 2.
4. Start the harness (step 4).

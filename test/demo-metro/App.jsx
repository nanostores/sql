import { useStore } from '@nanostores/react'
import { migrateIfNeeded, openDb } from '@nanostores/sql'
import { expoDriver } from '@nanostores/sql/expo'
import { atom } from 'nanostores'
import { Button, StyleSheet, Text, View } from 'react-native'

let $dbError = atom()

let db = openDb(expoDriver('expo-demo.sqlite'), {
  onError(error) {
    $dbError.set(error)
  }
})

let $migration = migrateIfNeeded(db, 1, async prevVersion => {
  if (prevVersion < 1) {
    await db.exec`CREATE TABLE counters
      (id INTEGER PRIMARY KEY AUTOINCREMENT, value INTEGER NOT NULL DEFAULT 0)`
  }
})

function CounterList() {
  let $counters = db.store`SELECT * FROM counters ORDER BY id`
  let state = useStore($counters)

  if (state.isLoading) {
    return <Text>Loading…</Text>
  }

  let counters = state.value

  return (
    <View>
      {counters.map(({ id, value }) => (
        <View key={id} style={styles.counter}>
          <Text style={styles.id}>#{id}</Text>
          <Button
            title="−"
            onPress={() =>
              db.exec`UPDATE counters SET value = value - 1 WHERE id = ${id}`
            }
          />
          <Text style={styles.value}>{value}</Text>
          <Button
            title="+"
            onPress={() =>
              db.exec`UPDATE counters SET value = value + 1 WHERE id = ${id}`
            }
          />
          <Button
            title="Delete"
            onPress={() => db.exec`DELETE FROM counters WHERE id = ${id}`}
          />
        </View>
      ))}
      <Button
        title="Add counter"
        onPress={() => db.exec`INSERT INTO counters (value) VALUES (0)`}
      />
    </View>
  )
}

function renderContent(migration, dbError) {
  if (dbError) return <Text>{dbError.message}</Text>
  if ('applying' in migration) return <Text>Running migrations…</Text>
  if ('outdated' in migration) return <Text>Page outdated, please reload.</Text>
  return <CounterList />
}

export default function App() {
  let migration = useStore($migration)
  let dbError = useStore($dbError)

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Nano Stores SQL Demo (Expo)</Text>
      {renderContent(migration, dbError)}
    </View>
  )
}

let styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 40,
    maxWidth: 480
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20
  },
  counter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginVertical: 4
  },
  id: {
    minWidth: 40
  },
  value: {
    minWidth: 40,
    textAlign: 'center'
  }
})

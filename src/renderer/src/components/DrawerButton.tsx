import { Menu } from 'lucide-react'
import { useNarrow } from '../lib/narrow'
import { useStore } from '../lib/store'
import { IconButton } from './ui'

/** Phone layout: opens the sidebar drawer. Renders nothing on wider screens. */
export default function DrawerButton() {
  const narrow = useNarrow()
  if (!narrow) return null
  return (
    <IconButton title="Menu" onClick={() => useStore.setState({ drawer: true })}>
      <Menu size={18} />
    </IconButton>
  )
}

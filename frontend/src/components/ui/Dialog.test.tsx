import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { Dialog, Sheet, SheetClose } from './Dialog'

function Harness({ sheet = false, initiallyOpen = false }: { sheet?: boolean; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  const fields = <><input aria-label="First field" /><button type="button">Last action</button></>
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open surface</button>
      <button type="button">Outside action</button>
      {sheet ? (
        <Sheet open={open} onOpenChange={setOpen} title="Navigation" side="left">
          {fields}
          <SheetClose>Close sheet</SheetClose>
        </Sheet>
      ) : (
        <Dialog open={open} onOpenChange={setOpen} title="Edit document">{fields}</Dialog>
      )}
    </>
  )
}

describe('controlled modal surfaces', () => {
  it('traps forward and backward tabbing, closes on Escape and restores the opener', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open surface' })
    await user.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'Edit document' })
    const close = within(dialog).getByRole('button', { name: 'Close dialog' })
    await waitFor(() => expect(close).toHaveFocus())
    await user.tab({ shift: true })
    expect(within(dialog).getByRole('button', { name: 'Last action' })).toHaveFocus()
    await user.tab()
    expect(close).toHaveFocus()
    await user.tab()
    expect(within(dialog).getByRole('textbox', { name: 'First field' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('restores focus after clicking the close control and after reopening', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Open surface' })
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await user.click(opener)
      await user.click(await screen.findByRole('button', { name: 'Close dialog' }))
      await waitFor(() => expect(opener).toHaveFocus())
    }
  })

  it('traps sheet focus and restores the opener on Escape or explicit close', async () => {
    const user = userEvent.setup()
    render(<Harness sheet />)
    const opener = screen.getByRole('button', { name: 'Open surface' })
    await user.click(opener)
    const sheet = await screen.findByRole('dialog', { name: 'Navigation' })
    await waitFor(() => expect(within(sheet).getByRole('textbox')).toHaveFocus())
    await user.tab({ shift: true })
    expect(within(sheet).getByRole('button', { name: 'Close sheet' })).toHaveFocus()
    await user.tab()
    expect(within(sheet).getByRole('textbox')).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(opener).toHaveFocus())
    await user.click(opener)
    await user.click(await screen.findByRole('button', { name: 'Close sheet' }))
    await waitFor(() => expect(opener).toHaveFocus())
  })
})

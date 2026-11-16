import { Component } from '@angular/core'
import { jsonApiMutation, jsonApiResource } from '@haddowg/json-api-angular'

/**
 * The caller's account, a singleton the server serves at `/me` with no id. The read takes no id,
 * and the rename passes the id the read returned, since the request body must carry it.
 */
@Component({
  selector: 'app-account',
  template: `
    @if (account.hasValue()) {
      <form (submit)="$event.preventDefault(); rename(name.value)">
        <span>Signed in as {{ account.value().displayName }}</span>
        <input #name [value]="account.value().displayName" aria-label="Display name" />
        <button type="submit" [disabled]="renaming.isPending()">Rename</button>
      </form>
      @if (renaming.jsonApiError(); as error) {
        <p class="error">{{ error.byPath()['displayName']?.[0]?.detail }}</p>
      }
    }
  `,
})
export class Account {
  protected readonly account = jsonApiResource({
    loader: ({ client, abortSignal }) => client.accounts.get({ signal: abortSignal }),
  })

  protected readonly renaming = jsonApiMutation(
    (client, input: { id: string; displayName: string }) => client.accounts.update(input),
  )

  protected async rename(displayName: string): Promise<void> {
    const account = this.account.value()
    if (account === undefined) {
      return
    }
    await this.renaming.mutate({ id: account.id, displayName })
    this.account.reload()
  }
}

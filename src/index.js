import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import waitFor from 'p-wait-for'
const log = Minilog('ContentScript')
Minilog.enable('payfitCCC')

const baseUrl = 'https://app.payfit.com/'
class TemplateContentScript extends ContentScript {
  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm')
    await this.goto(baseUrl)
    await Promise.race([
      this.waitForElementInWorker('#username'),
      this.waitForElementInWorker('#password'),
      this.waitForElementInWorker('div[data-testid="userInfoSection"]')
    ])
  }

  onWorkerReady() {
    this.log('info', '🤖 onWorkerReady')
    window.addEventListener('DOMContentLoaded', () => {
      this.log('info', 'DOMLoaded')
      const passwordButton = document.querySelector('._button-login-password')
      this.log('info', `passwordButton : ${Boolean(passwordButton)}`)
      if (passwordButton) {
        passwordButton.addEventListener('click', () => {
          const email = document.querySelector(
            '.ulp-authenticator-selector-text'
          )?.textContent
          const password = document.querySelector('#password')?.value
          this.log(
            'info',
            `interceptedCreds : ${JSON.stringify({ email, password })}`
          )
          this.bridge.emit('workerEvent', {
            event: 'loginSubmit',
            payload: { email, password }
          })
        })
      }
      const error = document.querySelector('.error')
      if (error) {
        this.bridge.emit('workerEvent', {
          event: 'loginError',
          payload: { msg: error.innerHTML }
        })
      }
    })
  }

  onWorkerEvent({ event, payload }) {
    this.log('info', '🤖 onWorkerEvent')
    if (event === 'loginSubmit') {
      this.log('info', 'received loginSubmit, blocking user interactions')
      this.blockWorkerInteractions()
      const { email, password } = payload || {}
      if (email && password) {
        this.log('info', 'EMAIL AND PASSWORD FOUND')
        this.store.userCredentials = { email, password }
      }
    } else if (event === 'loginError') {
      this.log(
        'info',
        'received loginError, unblocking user interactions: ' + payload?.msg
      )
      this.unblockWorkerInteractions()
    }
  }

  async ensureAuthenticated({ account }) {
    await this.bridge.call(
      'setUserAgent',
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:94.0) Gecko/20100101 Firefox/94.0'
    )
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    this.log('info', '🤖 ensureAuthenticated')
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'Not authenticated')
      await this.showLoginFormAndWaitForAuthentication()
    }
    if (await this.isElementInWorker('#code')) {
      this.log('info', 'Waiting for 2FA ...')
      await this.show2FAFormAndWaitForInput()
    }
    this.unblockWorkerInteractions()
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated')
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      return true
    } else {
      this.log('info', 'Already logged in, logging out')
      await this.clickAndWait(
        'div[data-testid="mobile-menu-toggle"]',
        'div[data-testid="accountDropdown"] > button'
      )
      await this.clickAndWait(
        'div[data-testid="accountDropdown"] > button',
        '#MIDNIGHT_1_1'
      )
      await this.clickAndWait('#MIDNIGHT_1_1', '#username')
      this.log('info', 'Logout OK')
    }
  }

  async checkAuthenticated() {
    this.log('info', '🤖 checkAuthenticated')
    if (document.querySelector('#code')) {
      this.log('info', 'Login OK - 2FA needed, wait for user action')
      return true
    }
    if (document.querySelector('div[data-testid="accountArrow"]')) {
      this.log('info', 'Login OK - Account selection needed')
      return true
    }
    if (document.querySelector('div[data-testid="userInfoSection"]')) {
      this.log('info', 'Login OK')
      return true
    }
    return false
  }

  async showLoginFormAndWaitForAuthentication() {
    log.debug('showLoginFormAndWaitForAuthentication start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async show2FAFormAndWaitForInput() {
    log.debug('show2FAFormAndWaitForInput start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({ method: 'waitFor2FA' })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite')
    if (await this.isElementInWorker('div[data-testid="accountArrow"]')) {
      await this.runInWorker('getNumberOfContracts')
      await this.clickAndWait(
        'div[data-testid="accountArrow"]',
        'div[data-testid="userInfoSection"]'
      )
    }
    return {
      sourceAccountIdentifier: 'defaultTemplateSourceAccountIdentifier'
    }
  }

  async fetch(context) {
    this.log('info', '🤖 fetch')
    if (this.store && this.store.userCredentials) {
      await this.saveCredentials(this.store.userCredentials)
    }
  }

  async waitFor2FA() {
    this.log('info', 'waitFor2FA starts')
    await waitFor(
      () => {
        if (document.querySelector('div[data-testid="userInfoSection"]')) {
          this.log('info', '2FA OK - Land on home')
          return true
        } else if (document.querySelector('div[data-testid="accountArrow"]')) {
          this.log('info', '2FA OK - Land on accounts selection')
          return true
        }
        return false
      },
      {
        interval: 1000,
        timeout: Infinity
      }
    )
    return true
  }

  async getNumberOfContracts() {
    this.log('info', 'getNumberOfContracts starts')
    const numberOfContracts = document.querySelectorAll(
      'div[data-testid="accountArrow"]'
    ).length
    await this.sendToPilot({ numberOfContracts })
  }
}

const connector = new TemplateContentScript()
connector
  .init({
    additionalExposedMethodsNames: ['waitFor2FA', 'getNumberOfContracts']
  })
  .catch(err => {
    log.warn(err)
  })

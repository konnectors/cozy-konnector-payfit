import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import waitFor from 'p-wait-for'
const log = Minilog('ContentScript')
Minilog.enable('payfitCCC')

const baseUrl = 'https://app.payfit.com/'
const personalInfosUrl = `${baseUrl}settings/profile`

let personalInfos = []
let userSettings = []

const fetchOriginal = window.fetch
window.fetch = async (...args) => {
  const response = await fetchOriginal(...args)
  if (
    typeof args[0] === 'string' &&
    args[0] === 'https://api.payfit.com/hr/user-settings/personal-information'
  ) {
    await response
      .clone()
      .json()
      .then(body => {
        personalInfos.push(body)
        return response
      })
      .catch(err => {
        // eslint-disable-next-line no-console
        console.log(err)
        return response
      })
  }
  if (
    typeof args[0] === 'string' &&
    args[0] === 'https://api.payfit.com/hr/user-settings'
  ) {
    await response
      .clone()
      .json()
      .then(body => {
        userSettings.push(body)
        return response
      })
      .catch(err => {
        // eslint-disable-next-line no-console
        console.log(err)
        return response
      })
  }
  return response
}

class PayfitContentScript extends ContentScript {
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

  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm')
    await this.goto(baseUrl)
    await Promise.race([
      this.waitForElementInWorker('#username'),
      this.waitForElementInWorker('#password'),
      this.waitForElementInWorker('div[data-testid="userInfoSection"]')
    ])
  }

  async ensureAuthenticated({ account }) {
    await this.bridge.call(
      'setUserAgent',
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:94.0) Gecko/20100101 Firefox/94.0'
    )
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    this.log('info', '🤖 ensureAuthenticated')
    // if (!account) {
    //   await this.ensureNotAuthenticated()
    // }
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
    await this.goto(personalInfosUrl)
    await this.waitForElementInWorker(
      'button[data-testid="changePersonalInformationButton"]'
    )
    await this.runInWorkerUntilTrue({
      method: 'checkInterception',
      args: ['identity']
    })
    await this.runInWorker('getIdentity')
    if (this.store.userIdentity.email[0]?.address) {
      return {
        sourceAccountIdentifier: this.store.userIdentity.email[0].address
      }
    } else {
      throw new Error('No email found for identity')
    }
  }

  async fetch(context) {
    this.log('info', '🤖 fetch')
    if (this.store && this.store.userCredentials) {
      await this.saveCredentials(this.store.userCredentials)
    }
    if (this.store.userIdentity) {
      this.log('info', 'Saving identity ...')
      await this.saveIdentity({ contact: this.store.userIdentity })
    }
    await this.waitForElementInWorker('[pause]')
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

  async checkInterception(type) {
    this.log('info', `📍️ checkInterception for ${type} starts`)
    await waitFor(
      () => {
        if (type === 'identity') {
          if (personalInfos.length > 0 && userSettings.length > 0) {
            this.log('info', 'personalInfos interception OK')
            return true
          }
          return false
        }
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return true
  }

  async getIdentity() {
    this.log('info', '📍️ getIdentity starts')
    const infos = personalInfos[0].variables
    const emails = userSettings[0].userEmails
    const userIdentity = {
      name: {
        givenName: infos.firstName,
        familyName: infos.birthName
      },
      address: [],
      email: [],
      phone: [
        {
          number: infos.phoneNumber,
          type: this.determinePhoneType(infos.phoneNumber)
        }
      ]
    }
    const foundAddress = this.getAddress(infos)
    for (const email of emails) {
      if (email.primary) {
        userIdentity.email.push({ address: email.address })
      }
    }
    userIdentity.address.push(foundAddress)
    await this.sendToPilot({ userIdentity })
  }

  determinePhoneType(phoneNumber) {
    this.log('info', '📍️ determinePhoneType starts')
    if (phoneNumber.startsWith('06') || phoneNumber.startsWith('07')) {
      return 'mobile'
    } else {
      return 'home'
    }
  }

  getAddress(infos) {
    this.log('info', '📍️ getAddress starts')
    let constructedAddress = ''
    const address = {}
    if (
      infos.addressNumber !== null &&
      !infos.address.includes(infos.addressNumber)
    ) {
      constructedAddress += infos.addressNumber
      address.streetNumer = infos.addressNumber
    } else {
      constructedAddress += infos.address
      address.street = infos.address
    }

    if (
      infos.addressStreetType !== null &&
      !infos.address.includes(infos.addressStreetType)
    ) {
      constructedAddress += ` ${infos.addressStreetType}`
      address.streetType = infos.addressStreetType
    }

    if (infos.additionalAddress !== null) {
      constructedAddress += ` ${infos.additionalAddress}`
      address.complement = infos.additionalAddress
    }

    constructedAddress += ` ${infos.postcode} ${infos.city} ${infos.country}`
    address.city = infos.city
    address.postCode = infos.postcode
    address.country = infos.country
    address.formattedAddress = constructedAddress

    return address
  }
}

const connector = new PayfitContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'waitFor2FA',
      'getNumberOfContracts',
      'getIdentity',
      'checkInterception'
    ]
  })
  .catch(err => {
    log.warn(err)
  })

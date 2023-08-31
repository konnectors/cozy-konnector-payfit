import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
Minilog.enable()

const baseUrl = 'https://toscrape.com'
const defaultSelector = "a[href='http://quotes.toscrape.com']"
const loginLinkSelector = `[href='/login']`
const logoutLinkSelector = `[href='/logout']`

class TemplateContentScript extends ContentScript {
  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm')
    await this.goto(baseUrl)
    await this.waitForElementInWorker(defaultSelector)
    await this.runInWorker('click', defaultSelector)
    // wait for both logout or login link to be sure to check authentication when ready
    await Promise.race([
      this.waitForElementInWorker(loginLinkSelector),
      this.waitForElementInWorker(logoutLinkSelector)
    ])
  }

  onWorkerEvent({ event, payload }) {
    if (event === 'loginSubmit') {
      this.log('info', 'received loginSubmit, blocking user interactions')
      this.blockWorkerInteractions()
    } else if (event === 'loginError') {
      this.log(
        'info',
        'received loginError, unblocking user interactions: ' + payload?.msg
      )
      this.unblockWorkerInteractions()
    }
  }

  async ensureAuthenticated({ account }) {
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
    this.unblockWorkerInteractions()
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated')
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      return true
    }

    await this.clickAndWait(logoutLinkSelector, loginLinkSelector)
    return true
  }

  onWorkerReady() {
    window.addEventListener('DOMContentLoaded', () => {
      const button = document.querySelector('input[type=submit]')
      if (button) {
        button.addEventListener('click', () =>
          this.bridge.emit('workerEvent', { event: 'loginSubmit' })
        )
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

  async checkAuthenticated() {
    return Boolean(document.querySelector(logoutLinkSelector))
  }

  async showLoginFormAndWaitForAuthentication() {
    log.debug('showLoginFormAndWaitForAuthentication start')
    await this.clickAndWait(loginLinkSelector, '#username')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async fetch(context) {
    this.log('info', '🤖 fetch')
    await this.goto('https://books.toscrape.com')
    await this.waitForElementInWorker('#promotions')
    const bills = await this.runInWorker('parseBills')

    await this.saveFiles(bills, {
      contentType: 'image/jpeg',
      fileIdAttributes: ['filename'],
      context
    })
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite')
    return {
      sourceAccountIdentifier: 'defaultTemplateSourceAccountIdentifier'
    }
  }

  async parseBills() {
    const articles = document.querySelectorAll('article')
    return Array.from(articles).map(article => ({
      amount: normalizePrice(article.querySelector('.price_color')?.innerHTML),
      filename: article.querySelector('h3 a')?.getAttribute('title'),
      fileurl:
        'https://books.toscrape.com/' +
        article.querySelector('img')?.getAttribute('src')
    }))
  }
}

// Convert a price string to a float
function normalizePrice(price) {
  return parseFloat(price.replace('£', '').trim())
}

const connector = new TemplateContentScript()
connector.init({ additionalExposedMethodsNames: ['parseBills'] }).catch(err => {
  log.warn(err)
})

import type { ComponentProps } from 'react'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { TextToImageForm } from '../TextToImageForm'
import { syncDynamicModelExports } from '@/lib/gemini-config'
import { saveRegistry } from '@/lib/nova-models'

async function renderForm(props: ComponentProps<typeof TextToImageForm>) {
  const result = render(<TextToImageForm {...props} />)
  await act(async () => {})
  return result
}

describe('TextToImageForm', () => {
  beforeEach(() => {
    localStorage.clear()
    saveRegistry({
      imageModels: [
        {
          id: 'gemini-3-pro-image-preview',
          protocol: 'google',
          name: 'Banana Pro',
          modelId: 'gemini-3-pro-image-preview',
          apiKey: 'test-google-key',
          baseUrl: 'https://generativelanguage.googleapis.com',
          builtinPreset: 'gemini-3-pro-image-preview',
          maxRefImages: 14,
          maxOutputSize: '4K',
          supportsAdvancedParams: false,
        },
        {
          id: 'gpt-image-2',
          protocol: 'openai',
          name: 'GPT Image 2',
          modelId: 'gpt-image-2',
          apiKey: 'test-openai-key',
          baseUrl: 'https://api.openai.com',
          builtinPreset: 'gpt-image-2',
          maxRefImages: 16,
          maxOutputSize: '4K',
          supportsAdvancedParams: true,
        },
      ],
      textModels: [],
      defaults: {
        textToImage: 'gemini-3-pro-image-preview',
        imageToImage: 'gemini-3-pro-image-preview',
        reversePrompt: '',
        agent: '',
        promptOptimize: '',
        layoutSpec: '',
        imageDescribe: '',
        sliceDecomposition: '',
        sliceReconstruct: '',
        sliceImageEdit: '',
      },
    })
    syncDynamicModelExports()
  })

  it('renders the form with placeholder text', async () => {
    const onSubmit = vi.fn()
    await renderForm({ onSubmit })

    expect(screen.getByPlaceholderText('描述你想要生成的图像...')).toBeInTheDocument()
  })

  it('submit button is disabled when prompt is empty', async () => {
    const onSubmit = vi.fn()
    await renderForm({ onSubmit })

    const submitButton = screen.getByRole('button', { name: '' }) // Arrow icon button
    expect(submitButton).toBeDisabled()
  })

  it('submit button is enabled when prompt has text', async () => {
    const onSubmit = vi.fn()
    await renderForm({ onSubmit })

    const textarea = screen.getByPlaceholderText('描述你想要生成的图像...')
    fireEvent.change(textarea, { target: { value: 'A beautiful sunset' } })

    const submitButton = screen.getByRole('button', { name: '' })
    expect(submitButton).not.toBeDisabled()
  })

  it('calls onSubmit with prompt when Shift+Enter is pressed', async () => {
    const onSubmit = vi.fn()
    await renderForm({ onSubmit })

    const textarea = screen.getByPlaceholderText('描述你想要生成的图像...')
    fireEvent.change(textarea, { target: { value: 'A beautiful sunset' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompts: ['A beautiful sunset'],
      outputSize: '1K',
      aspectRatio: '1:1',
      temperature: 1,
      model: 'gemini-3-pro-image-preview',
      gptImageQuality: 'auto',
      gptImageStyle: 'auto',
      gptImageBackground: 'auto',
      parallelCount: 1,
    }))
  })

  it('shows image params control for GPT Image 2 model', async () => {
    const onSubmit = vi.fn()
    await renderForm({ onSubmit, initialData: { model: 'gpt-image-2' } })

    expect(await screen.findByTitle('图像参数')).toBeInTheDocument()
  })

  it('submits default image params for GPT Image 2 model when left on auto', async () => {
    const onSubmit = vi.fn()
    await renderForm({
      onSubmit,
      initialData: { model: 'gpt-image-2', prompt: 'Cut out the subject' },
    })

    const textarea = screen.getByPlaceholderText('描述你想要生成的图像...')
    await screen.findByTitle('图像参数')
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-image-2',
      gptImageQuality: 'auto',
      gptImageStyle: 'auto',
      gptImageBackground: 'auto',
    }))
  })

  it('does NOT submit when plain Enter is pressed', async () => {
    const onSubmit = vi.fn()
    await renderForm({ onSubmit })

    const textarea = screen.getByPlaceholderText('描述你想要生成的图像...')
    fireEvent.change(textarea, { target: { value: 'A beautiful sunset' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows configuration prompt when disabled prop is true', async () => {
    const onSubmit = vi.fn()
    await renderForm({ onSubmit, disabled: true })

    expect(screen.getByText('API 密钥未配置')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '配置' })).toBeInTheDocument()
  })
})

package com.kirandp.advertisementapp.video

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaExtractor
import android.media.MediaMuxer
import android.net.Uri
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.min

class AndroidVideoEncoderModule(
  reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "AndroidVideoEncoder"

  @ReactMethod
  fun encodePngSequence(
    frameDirUri: String,
    outputUri: String,
    fpsDouble: Double,
    bitRateDouble: Double,
    promise: Promise
  ) {
    Thread {
      try {
        val fps = max(1, fpsDouble.toInt())
        val bitRate = max(500_000, bitRateDouble.toInt())

        val frameDir = File(toFilePath(frameDirUri))
        if (!frameDir.exists() || !frameDir.isDirectory) {
          throw IllegalArgumentException("Frame directory not found: $frameDirUri")
        }

        val frames = frameDir
          .listFiles { file ->
            file.isFile &&
              file.name.lowercase().endsWith(".png") &&
              file.name.startsWith("frame_")
          }
          ?.sortedBy { it.name }
          ?: emptyList()

        if (frames.isEmpty()) {
          throw IllegalArgumentException("No PNG frames found in: $frameDirUri")
        }

        val outputPath = toFilePath(outputUri)
        val outputFile = File(outputPath)
        outputFile.parentFile?.mkdirs()
        if (outputFile.exists()) outputFile.delete()

        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(frames.first().absolutePath, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
          throw IllegalArgumentException("Could not read first frame size.")
        }

        // H.264 encoders usually require even dimensions.
        val videoWidth = bounds.outWidth - (bounds.outWidth % 2)
        val videoHeight = bounds.outHeight - (bounds.outHeight % 2)

        encodeFrames(frames, outputPath, videoWidth, videoHeight, fps, bitRate)
        promise.resolve(if (outputUri.startsWith("file://")) outputUri else "file://$outputPath")
      } catch (t: Throwable) {
        promise.reject("VIDEO_ENCODE_FAILED", t.message, t)
      }
    }.start()
  }

  private fun encodeFrames(
    frames: List<File>,
    outputPath: String,
    width: Int,
    height: Int,
    fps: Int,
    bitRate: Int
  ) {
    val mime = MediaFormat.MIMETYPE_VIDEO_AVC
    val codecInfo = selectCodec(mime)
      ?: throw IllegalStateException("No H.264 encoder found on this Android device.")
    val colorFormat = selectColorFormat(codecInfo, mime)
    val semiPlanar = isSemiPlanar(colorFormat)

    val format = MediaFormat.createVideoFormat(mime, width, height).apply {
      setInteger(MediaFormat.KEY_COLOR_FORMAT, colorFormat)
      setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
      setInteger(MediaFormat.KEY_FRAME_RATE, fps)
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
    }

    val encoder = MediaCodec.createByCodecName(codecInfo.name)
    val bufferInfo = MediaCodec.BufferInfo()
    var muxer: MediaMuxer? = null
    var trackIndex = -1
    var muxerStarted = false

    try {
      encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      encoder.start()
      muxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

      var frameIndex = 0
      var inputDone = false
      var encoderDone = false

      while (!encoderDone) {
        if (!inputDone) {
          val inputBufferIndex = encoder.dequeueInputBuffer(10_000)
          if (inputBufferIndex >= 0) {
            val inputBuffer = encoder.getInputBuffer(inputBufferIndex)
              ?: throw IllegalStateException("Encoder input buffer is null.")
            inputBuffer.clear()

            if (frameIndex < frames.size) {
              val bitmap = decodeScaledBitmap(frames[frameIndex], width, height)
              val yuv = bitmapToYuv420(bitmap, width, height, semiPlanar)
              bitmap.recycle()

              inputBuffer.put(yuv)
              val presentationTimeUs = computePresentationTimeUs(frameIndex, fps)
              encoder.queueInputBuffer(
                inputBufferIndex,
                0,
                yuv.size,
                presentationTimeUs,
                0
              )
              frameIndex += 1
            } else {
              encoder.queueInputBuffer(
                inputBufferIndex,
                0,
                0,
                computePresentationTimeUs(frameIndex, fps),
                MediaCodec.BUFFER_FLAG_END_OF_STREAM
              )
              inputDone = true
            }
          }
        }

        var outputAvailable = true
        while (outputAvailable) {
          when (val outputBufferIndex = encoder.dequeueOutputBuffer(bufferInfo, 10_000)) {
            MediaCodec.INFO_TRY_AGAIN_LATER -> {
              outputAvailable = false
            }

            MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
              if (muxerStarted) {
                throw IllegalStateException("Encoder output format changed twice.")
              }
              val newFormat = encoder.outputFormat
              trackIndex = muxer.addTrack(newFormat)
              muxer.start()
              muxerStarted = true
            }

            MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED -> {
              // Deprecated on modern Android. Safe to ignore.
            }

            else -> {
              if (outputBufferIndex < 0) continue

              val encodedData: ByteBuffer = encoder.getOutputBuffer(outputBufferIndex)
                ?: throw IllegalStateException("Encoder output buffer is null.")

              if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                bufferInfo.size = 0
              }

              if (bufferInfo.size > 0) {
                if (!muxerStarted) {
                  throw IllegalStateException("Muxer has not started.")
                }

                encodedData.position(bufferInfo.offset)
                encodedData.limit(bufferInfo.offset + bufferInfo.size)
                muxer.writeSampleData(trackIndex, encodedData, bufferInfo)
              }

              encoder.releaseOutputBuffer(outputBufferIndex, false)

              if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                encoderDone = true
                outputAvailable = false
              }
            }
          }
        }
      }
    } finally {
      try {
        encoder.stop()
      } catch (_: Throwable) {
      }
      try {
        encoder.release()
      } catch (_: Throwable) {
      }
      try {
        muxer?.stop()
      } catch (_: Throwable) {
      }
      try {
        muxer?.release()
      } catch (_: Throwable) {
      }
    }
  }

  private fun selectCodec(mimeType: String): MediaCodecInfo? {
    val codecList = MediaCodecList(MediaCodecList.REGULAR_CODECS)
    return codecList.codecInfos.firstOrNull { codecInfo ->
      codecInfo.isEncoder && codecInfo.supportedTypes.any { it.equals(mimeType, ignoreCase = true) }
    }
  }

  private fun selectColorFormat(codecInfo: MediaCodecInfo, mimeType: String): Int {
    val capabilities = codecInfo.getCapabilitiesForType(mimeType)
    val preferred = listOf(
      MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420SemiPlanar,
      MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Planar,
      MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible
    )

    preferred.firstOrNull { wanted ->
      capabilities.colorFormats.any { it == wanted }
    }?.let { return it }

    throw IllegalStateException(
      "No supported YUV420 color format found for encoder: ${codecInfo.name}"
    )
  }

  private fun isSemiPlanar(colorFormat: Int): Boolean {
    return colorFormat == MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420SemiPlanar ||
      colorFormat == MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible
  }

  private fun decodeScaledBitmap(file: File, width: Int, height: Int): Bitmap {
    val src = BitmapFactory.decodeFile(file.absolutePath)
      ?: throw IllegalArgumentException("Could not decode frame: ${file.name}")

    val output = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(output)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG or Paint.DITHER_FLAG)

    canvas.drawColor(Color.BLACK)
    val srcRect = Rect(0, 0, src.width, src.height)
    val dstRect = Rect(0, 0, width, height)
    canvas.drawBitmap(src, srcRect, dstRect, paint)
    src.recycle()
    return output
  }

  private fun bitmapToYuv420(
    bitmap: Bitmap,
    width: Int,
    height: Int,
    semiPlanar: Boolean
  ): ByteArray {
    val argb = IntArray(width * height)
    bitmap.getPixels(argb, 0, width, 0, 0, width, height)

    val frameSize = width * height
    val qFrameSize = frameSize / 4
    val yuv = ByteArray(frameSize + frameSize / 2)

    var yIndex = 0
    var uvIndex = frameSize
    var uIndex = frameSize
    var vIndex = frameSize + qFrameSize

    for (j in 0 until height) {
      for (i in 0 until width) {
        val c = argb[j * width + i]
        val r = (c shr 16) and 0xff
        val g = (c shr 8) and 0xff
        val b = c and 0xff

        val y = ((66 * r + 129 * g + 25 * b + 128) shr 8) + 16
        val u = ((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128
        val v = ((112 * r - 94 * g - 18 * b + 128) shr 8) + 128

        yuv[yIndex++] = clampToByte(y)

        if (j % 2 == 0 && i % 2 == 0) {
          if (semiPlanar) {
            // NV12: Y plane, then interleaved U/V.
            yuv[uvIndex++] = clampToByte(u)
            yuv[uvIndex++] = clampToByte(v)
          } else {
            // I420: Y plane, U plane, V plane.
            yuv[uIndex++] = clampToByte(u)
            yuv[vIndex++] = clampToByte(v)
          }
        }
      }
    }

    return yuv
  }

  private fun clampToByte(value: Int): Byte {
    return min(255, max(0, value)).toByte()
  }

  private fun computePresentationTimeUs(frameIndex: Int, fps: Int): Long {
    return 132L + frameIndex * 1_000_000L / fps
  }

  private fun toFilePath(uriOrPath: String): String {
    return when {
      uriOrPath.startsWith("file://") -> Uri.parse(uriOrPath).path ?: uriOrPath.removePrefix("file://")
      else -> uriOrPath
    }
  }

  private data class PcmChunk(
    val data: ByteArray,
    var offset: Int = 0
  )

  /**
   * Converts the selected source track (MP3 and other decoder-supported audio)
   * to AAC in an M4A container. Android's MP4 muxer is consistently compatible
   * with AAC, while directly adding an MP3 track can create a silent MP4.
   */
  private fun transcodeAudioToAac(inputPath: String, outputPath: String) {
    val extractor = MediaExtractor()
    var decoder: MediaCodec? = null
    var encoder: MediaCodec? = null
    var audioMuxer: MediaMuxer? = null
    var muxerStarted = false

    try {
      extractor.setDataSource(inputPath)
      var sourceTrack = -1
      var sourceFormat: MediaFormat? = null
      for (i in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(i)
        val mime = format.getString(MediaFormat.KEY_MIME) ?: ""
        if (mime.startsWith("audio/")) {
          sourceTrack = i
          sourceFormat = format
          break
        }
      }
      if (sourceTrack < 0 || sourceFormat == null) {
        throw IllegalStateException("No audio track found in: $inputPath")
      }

      extractor.selectTrack(sourceTrack)
      val sourceMime = sourceFormat.getString(MediaFormat.KEY_MIME)
        ?: throw IllegalStateException("Audio MIME type is missing.")
      val sampleRate = if (sourceFormat.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
        sourceFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      } else 44_100
      val channelCount = if (sourceFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) {
        min(2, max(1, sourceFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)))
      } else 2

      decoder = MediaCodec.createDecoderByType(sourceMime)
      decoder.configure(sourceFormat, null, null, 0)
      decoder.start()

      val aacFormat = MediaFormat.createAudioFormat(
        MediaFormat.MIMETYPE_AUDIO_AAC,
        sampleRate,
        channelCount
      ).apply {
        setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
        setInteger(MediaFormat.KEY_BIT_RATE, 128_000)
        setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024)
      }

      encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
      encoder.configure(aacFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      encoder.start()

      val outputFile = File(outputPath)
      outputFile.parentFile?.mkdirs()
      if (outputFile.exists()) outputFile.delete()
      audioMuxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

      val decoderInfo = MediaCodec.BufferInfo()
      val encoderInfo = MediaCodec.BufferInfo()
      val pcmQueue = java.util.ArrayDeque<PcmChunk>()
      var decoderInputDone = false
      var decoderOutputDone = false
      var encoderInputDone = false
      var encoderOutputDone = false
      var audioTrack = -1
      var totalPcmFrames = 0L
      val bytesPerFrame = channelCount * 2 // decoder PCM is 16-bit on Android

      while (!encoderOutputDone) {
        if (!decoderInputDone) {
          val inputIndex = decoder.dequeueInputBuffer(10_000)
          if (inputIndex >= 0) {
            val inputBuffer = decoder.getInputBuffer(inputIndex)
              ?: throw IllegalStateException("Audio decoder input buffer is null.")
            inputBuffer.clear()
            val sampleSize = extractor.readSampleData(inputBuffer, 0)
            if (sampleSize < 0) {
              decoder.queueInputBuffer(
                inputIndex,
                0,
                0,
                0,
                MediaCodec.BUFFER_FLAG_END_OF_STREAM
              )
              decoderInputDone = true
            } else {
              decoder.queueInputBuffer(
                inputIndex,
                0,
                sampleSize,
                max(0L, extractor.sampleTime),
                extractor.sampleFlags
              )
              extractor.advance()
            }
          }
        }

        if (!decoderOutputDone) {
          when (val outputIndex = decoder.dequeueOutputBuffer(decoderInfo, 10_000)) {
            MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
            MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> Unit
            else -> if (outputIndex >= 0) {
              val outputBuffer = decoder.getOutputBuffer(outputIndex)
              if (decoderInfo.size > 0 && outputBuffer != null) {
                outputBuffer.position(decoderInfo.offset)
                outputBuffer.limit(decoderInfo.offset + decoderInfo.size)
                val pcm = ByteArray(decoderInfo.size)
                outputBuffer.get(pcm)
                pcmQueue.add(PcmChunk(pcm))
              }
              if ((decoderInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                decoderOutputDone = true
              }
              decoder.releaseOutputBuffer(outputIndex, false)
            }
          }
        }

        if (!encoderInputDone && (pcmQueue.isNotEmpty() || decoderOutputDone)) {
          val inputIndex = encoder.dequeueInputBuffer(10_000)
          if (inputIndex >= 0) {
            val inputBuffer = encoder.getInputBuffer(inputIndex)
              ?: throw IllegalStateException("AAC encoder input buffer is null.")
            inputBuffer.clear()

            var bytesWritten = 0
            while (inputBuffer.hasRemaining() && pcmQueue.isNotEmpty()) {
              val chunk = pcmQueue.peek()
              val count = min(inputBuffer.remaining(), chunk.data.size - chunk.offset)
              inputBuffer.put(chunk.data, chunk.offset, count)
              chunk.offset += count
              bytesWritten += count
              if (chunk.offset >= chunk.data.size) pcmQueue.remove()
            }

            if (bytesWritten > 0) {
              val ptsUs = totalPcmFrames * 1_000_000L / sampleRate
              totalPcmFrames += bytesWritten / bytesPerFrame
              encoder.queueInputBuffer(inputIndex, 0, bytesWritten, ptsUs, 0)
            } else if (decoderOutputDone && pcmQueue.isEmpty()) {
              val ptsUs = totalPcmFrames * 1_000_000L / sampleRate
              encoder.queueInputBuffer(
                inputIndex,
                0,
                0,
                ptsUs,
                MediaCodec.BUFFER_FLAG_END_OF_STREAM
              )
              encoderInputDone = true
            }
          }
        }

        var keepDrainingEncoder = true
        while (keepDrainingEncoder) {
          when (val outputIndex = encoder.dequeueOutputBuffer(encoderInfo, 10_000)) {
            MediaCodec.INFO_TRY_AGAIN_LATER -> keepDrainingEncoder = false
            MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
              if (muxerStarted) throw IllegalStateException("AAC encoder format changed twice.")
              audioTrack = audioMuxer.addTrack(encoder.outputFormat)
              audioMuxer.start()
              muxerStarted = true
            }
            else -> if (outputIndex >= 0) {
              val encodedBuffer = encoder.getOutputBuffer(outputIndex)
                ?: throw IllegalStateException("AAC encoder output buffer is null.")
              if ((encoderInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                encoderInfo.size = 0
              }
              if (encoderInfo.size > 0) {
                if (!muxerStarted) throw IllegalStateException("AAC muxer has not started.")
                encodedBuffer.position(encoderInfo.offset)
                encodedBuffer.limit(encoderInfo.offset + encoderInfo.size)
                audioMuxer.writeSampleData(audioTrack, encodedBuffer, encoderInfo)
              }
              if ((encoderInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                encoderOutputDone = true
                keepDrainingEncoder = false
              }
              encoder.releaseOutputBuffer(outputIndex, false)
            }
          }
        }
      }
    } finally {
      try { extractor.release() } catch (_: Throwable) {}
      try { decoder?.stop() } catch (_: Throwable) {}
      try { decoder?.release() } catch (_: Throwable) {}
      try { encoder?.stop() } catch (_: Throwable) {}
      try { encoder?.release() } catch (_: Throwable) {}
      try { if (muxerStarted) audioMuxer?.stop() } catch (_: Throwable) {}
      try { audioMuxer?.release() } catch (_: Throwable) {}
    }
  }

  /**
   * Muxes a video-only MP4 with music. The music is first normalized to AAC,
   * then trimmed or looped so the exported file has audio for its full duration.
   */
  @ReactMethod
  fun muxAudioWithVideo(
    videoUri: String,
    audioUri: String,
    outputUri: String,
    promise: Promise
  ) {
    Thread {
      var videoExtractor: MediaExtractor? = null
      var audioExtractor: MediaExtractor? = null
      var muxer: MediaMuxer? = null
      var muxerStarted = false
      var normalizedAudioFile: File? = null
      try {
        val videoPath = toFilePath(videoUri)
        val audioPath = toFilePath(audioUri)
        val outputPath = toFilePath(outputUri)
        val outputFile = File(outputPath)
        outputFile.parentFile?.mkdirs()
        if (outputFile.exists()) outputFile.delete()

        normalizedAudioFile = File(
          outputFile.parentFile,
          "normalized-audio-${System.currentTimeMillis()}.m4a"
        )
        transcodeAudioToAac(audioPath, normalizedAudioFile.absolutePath)

        videoExtractor = MediaExtractor().apply { setDataSource(videoPath) }
        var videoTrackIndex = -1
        var videoFormat: MediaFormat? = null
        for (i in 0 until videoExtractor.trackCount) {
          val format = videoExtractor.getTrackFormat(i)
          val mime = format.getString(MediaFormat.KEY_MIME) ?: ""
          if (mime.startsWith("video/")) {
            videoTrackIndex = i
            videoFormat = format
            break
          }
        }
        if (videoTrackIndex < 0 || videoFormat == null) {
          throw IllegalStateException("No video track found in: $videoPath")
        }
        val videoDurationUs = videoFormat.getLong(MediaFormat.KEY_DURATION)

        audioExtractor = MediaExtractor().apply {
          setDataSource(normalizedAudioFile.absolutePath)
        }
        var audioTrackIndex = -1
        var audioFormat: MediaFormat? = null
        for (i in 0 until audioExtractor.trackCount) {
          val format = audioExtractor.getTrackFormat(i)
          val mime = format.getString(MediaFormat.KEY_MIME) ?: ""
          if (mime.startsWith("audio/")) {
            audioTrackIndex = i
            audioFormat = format
            break
          }
        }
        if (audioTrackIndex < 0 || audioFormat == null) {
          throw IllegalStateException("AAC conversion produced no audio track.")
        }
        val audioDurationUs = if (audioFormat.containsKey(MediaFormat.KEY_DURATION)) {
          audioFormat.getLong(MediaFormat.KEY_DURATION)
        } else 0L
        if (audioDurationUs <= 0L) {
          throw IllegalStateException("Converted audio has an invalid duration.")
        }

        muxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        val muxVideoTrack = muxer.addTrack(videoFormat)
        val muxAudioTrack = muxer.addTrack(audioFormat)
        muxer.start()
        muxerStarted = true

        videoExtractor.selectTrack(videoTrackIndex)
        val videoBuffer = ByteBuffer.allocate(4 * 1024 * 1024)
        val videoInfo = MediaCodec.BufferInfo()
        while (true) {
          videoBuffer.clear()
          val sampleSize = videoExtractor.readSampleData(videoBuffer, 0)
          if (sampleSize < 0) break
          videoInfo.set(0, sampleSize, max(0L, videoExtractor.sampleTime), videoExtractor.sampleFlags)
          muxer.writeSampleData(muxVideoTrack, videoBuffer, videoInfo)
          videoExtractor.advance()
        }

        audioExtractor.selectTrack(audioTrackIndex)
        val audioBuffer = ByteBuffer.allocate(1024 * 1024)
        val audioInfo = MediaCodec.BufferInfo()
        var loopIndex = 0L
        var lastWrittenTimeUs = -1L

        while (true) {
          audioExtractor.seekTo(0, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
          var wroteInLoop = false

          while (true) {
            audioBuffer.clear()
            val sampleSize = audioExtractor.readSampleData(audioBuffer, 0)
            if (sampleSize < 0) break

            val sourceTimeUs = max(0L, audioExtractor.sampleTime)
            var adjustedTimeUs = sourceTimeUs + loopIndex * audioDurationUs
            if (adjustedTimeUs >= videoDurationUs) break
            if (adjustedTimeUs <= lastWrittenTimeUs) {
              adjustedTimeUs = lastWrittenTimeUs + 1L
            }

            audioInfo.set(0, sampleSize, adjustedTimeUs, audioExtractor.sampleFlags)
            muxer.writeSampleData(muxAudioTrack, audioBuffer, audioInfo)
            lastWrittenTimeUs = adjustedTimeUs
            wroteInLoop = true
            audioExtractor.advance()
          }

          loopIndex += 1L
          if (!wroteInLoop || loopIndex * audioDurationUs >= videoDurationUs) break
        }

        muxer.stop()
        muxer.release()
        muxer = null
        muxerStarted = false

        promise.resolve(
          if (outputUri.startsWith("file://")) outputUri else "file://$outputPath"
        )
      } catch (t: Throwable) {
        promise.reject("AUDIO_MUX_FAILED", t.message, t)
      } finally {
        try { videoExtractor?.release() } catch (_: Throwable) {}
        try { audioExtractor?.release() } catch (_: Throwable) {}
        try { if (muxerStarted) muxer?.stop() } catch (_: Throwable) {}
        try { muxer?.release() } catch (_: Throwable) {}
        try { normalizedAudioFile?.delete() } catch (_: Throwable) {}
      }
    }.start()
  }

}
